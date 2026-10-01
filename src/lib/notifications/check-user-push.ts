import { db } from "@/lib/db";
import { isPlanReviewJobCreating } from "@/lib/dispatch/dispatch-job";
import type { DispatchJobStatus } from "@/lib/dispatch/dispatch-job";
import {
  CHECK_USER_REASON_TEXT,
  checkUserReason,
  type CheckUserReason,
} from "@/lib/github/approval-labels";
import {
  isPushConfigured,
  sendPushNotification,
  type PushNotificationPayload,
} from "@/lib/notifications/push";

/**
 * 確認待ち（`00.check-user`）になったIssueのPush通知（#838）。
 *
 * **ラベルが付いた瞬間には送らない。** 少し待ってから、そのとき残っているラベルを読んで送る。
 * 理由は2つあり、どちらも「鳴ってからでは取り消せない」ことに由来する。
 *
 * - **早すぎる`00.check-user`が実際にある**（#1709）。実装エージェントはPR作成の直後に
 *   自分で`00.check-user`＋`01.check-merge`を付けるが、その時点ではCIが走っていてマージ
 *   できない。#1709の例では10分後に自動マージされ、ラベルごと消えた——通知そのものが
 *   不要だった。画面のトースト（`check-user-notification.ts`）は出す前に保留できるが、
 *   OSの通知はそうはいかない。そこで`01.check-merge`だけ待ち時間を長く取り、
 *   **自動で消えるものは鳴る前に消えている**状態にする
 * - **理由ラベル（`01.check-*`）は`00.check-user`より後に付く**。ローカルセッションの経路は
 *   `00.check-user`を単独で先に付け、理由は続く別のリクエストで付ける
 *   （`dispatch/check-user-labels.ts`）。付いた瞬間に読むと理由が引けず、
 *   「確認待ちになりました」としか言えない
 *
 * **例外は「画面から答えられる待ちが生きているとき」**（#2238）。計画の承認待ち・質問の
 * 回答待ちは、待ちを作った時点で理由ラベルまで確定しており、人が答えるまで自動では消えない。
 * 上の2つの理由がどちらも当てはまらないので待たずに送る（`decideCheckUserPush`）。
 *
 * **「いまは実施しない」として伏せているユーザーへは送らない**（#2398）。非表示リポジトリ
 * （#2279）と同じく宛先の側で落とし、**宛先が全員保留なら送信済みの記録も付けない**——
 * 付けると保留を解除しても二度と鳴らないため、次の巡回へ回して保留が解けるのを待つ。
 *
 * 送信済みかどうかは`Issue.checkUserPushSentAt`で持つ。`00.check-user`が付き直すたびに
 * `checkUserLabeledAt`とセットでnullへ戻る（`github/sync-issues.ts`）ので、
 * 「まだnullで、付与から待ち時間が過ぎたもの」が未送信の集合になる。**この記録は送る前に
 * 立てて席を取る**（#2300。`reserveCheckUserPush`）——巡回は同時に何本も走るため、
 * 送ってから付けていると同じ通知が続けて2件届く。
 */

/** 既定の待ち時間。理由ラベルが揃うのを待つだけなので短くてよい */
export const CHECK_USER_PUSH_DELAY_MS = 3 * 60 * 1000;

/**
 * `01.check-merge`だけの待ち時間。
 *
 * トーストの保留の上限（`CHECK_USER_TOAST_MAX_HOLD_MS` = 10分）より長く取る。CIの完了と
 * それに続く自動マージがこの中で終われば、ラベルは消えて通知は送られない。**それでも
 * 残っているなら、人がマージするしかないもの**（自動マージ不可カテゴリ）なので通知する。
 */
export const CHECK_USER_MERGE_PUSH_DELAY_MS = 15 * 60 * 1000;

/**
 * これより古い確認待ちは、未送信でも通知しない（記録だけ付けて終わる）。
 *
 * 機能を入れた直後や、購読を後から登録したときに、**溜まっていた確認待ちが一斉に鳴る**のを
 * 防ぐ。半日以上前から待っているものは、開けばベルにも一覧にも出ている。
 */
export const CHECK_USER_PUSH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 1回の巡回で見る件数の上限。取りこぼしても次の巡回で拾える */
const SWEEP_BATCH_SIZE = 50;

/** 理由ごとの待ち時間 */
export function checkUserPushDelayMs(reason: CheckUserReason | null): number {
  return reason === "merge" ? CHECK_USER_MERGE_PUSH_DELAY_MS : CHECK_USER_PUSH_DELAY_MS;
}

export type CheckUserPushDecision = "send" | "wait" | "skip";

/**
 * いま送ってよいか。`skip`は「送らずに送信済みとして記録する」（古すぎるもの）。
 *
 * 理由ラベルが読めない（配られていない）リポジトリは既定の待ち時間で送る。
 * 判断できないものを黙らせると、通知が来ないことにも気づけないため。
 *
 * **画面から答えられる待ち（計画の承認・質問の回答）が生きているなら待たない**（#2238）。
 * 待ち時間の意味は「理由ラベルが揃うのを待つ」「早すぎる`00.check-user`が自動で消えるのを
 * 待つ」の2つだが、待ちがあるならどちらも当てはまらない——理由は既に確定していて
 * （`01.check-plan`・`01.check-input`）、その待ちは人が答えるまで消えない。
 * **質問の待ち時間は既定30分**（`SESSION_QUESTION_WAIT_SECONDS_DEFAULT`。#2850で計画と
 * 統一した）。3分待ってから送っても届くのに十分な余裕が残る。
 */
export function decideCheckUserPush(input: {
  labels: readonly { name: string }[];
  checkUserLabeledAt: Date;
  /**
   * そのIssueに、まだ期限の来ていない計画・質問の待ちがあるか（#2238）。
   * **省略時は従来どおり待ち時間だけで決める**——待ちを引けない呼び出し元で、
   * 判定できないことを理由に通知を早めないため。
   */
  hasPendingSessionRequest?: boolean;
  /**
   * この時刻まで送らない（#2772。夜間実行で起動したIssueの確認待ちを翌朝まで止めるために
   * 導入したが、夜間実行自体は#3019で削除した。呼び出し元は現在渡していないが、深夜に鳴らし
   * たくない起動経路が今後増えたときのために口だけ残してある）。**待ちが生きていても止める**
   * ——待たずに送る理由（理由が確定していて自動では消えない）はそのままだが、鳴らす時刻の
   * 方が先に立つ。`null`・省略は従来どおり
   */
  holdUntil?: Date | null;
  /**
   * 計画レビュー（G1）が届いて自動で反映されるまで送らない（#3616。`selectPlanReviewHoldKeys`）。
   * **待ちが生きていても止める**——待たずに送る理由（理由が確定していて自動では消えない）より、
   * 「反映が済んでいない計画を人に見せない」ことを優先する。省略時は従来どおり
   */
  holdForPlanReview?: boolean;
  now: Date;
}): CheckUserPushDecision {
  if (input.holdForPlanReview) return "wait";
  if (input.holdUntil && input.now.getTime() < input.holdUntil.getTime()) return "wait";
  if (input.hasPendingSessionRequest) return "send";
  const elapsed = input.now.getTime() - input.checkUserLabeledAt.getTime();
  if (elapsed >= CHECK_USER_PUSH_MAX_AGE_MS) return "skip";
  const reason = checkUserReason(input.labels);
  return elapsed >= checkUserPushDelayMs(reason) ? "send" : "wait";
}

/**
 * 通知の中身。1行目にIssue、2行目にリポジトリと「何を求められているか」を置く。
 * 文言は画面内のトースト（`check-user-toast-viewport.tsx`）と同じ語彙にそろえる。
 */
export function buildCheckUserPushPayload(issue: {
  githubIssueId: bigint;
  number: number;
  title: string;
  repositoryFullName: string;
  labels: readonly { name: string }[];
}): PushNotificationPayload {
  const reason = checkUserReason(issue.labels);
  const repositoryName = issue.repositoryFullName.split("/")[1] ?? issue.repositoryFullName;
  const issueId = String(issue.githubIssueId);
  return {
    title: `#${issue.number} ${issue.title}`,
    body: `${repositoryName} ・ ${reason ? CHECK_USER_REASON_TEXT[reason] : "確認待ち"}`,
    // PC（`issue`）とスマホ（`mscreen`・`missue`）で現在地の持ち方が違うので両方載せる。
    // `useReferenceNavigation.openIssue`が画面内のリンクで組み立てるURLと同じ形
    url: `/dashboard?issue=${issueId}&mscreen=issue-detail&missue=${issueId}`,
    tag: `check-user:${issueId}`,
  };
}

function sessionRequestKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

/**
 * 渡したIssueのうち、**まだ期限の来ていない計画・質問の待ち**があるものの鍵を返す（#2238）。
 *
 * 見るのは`WAITING`かつ`expiresAt`が未来のものだけ。`WAITING`は本来フックのポーリングが
 * 期限切れを`EXPIRED`へ倒すが（`plan-requests.ts`・`question-requests.ts`）、セッションが
 * 落ちてポーリングが止まると`WAITING`のまま残る。**残骸を理由に通知を早めない**ため、
 * 期限そのものを見る。
 *
 * リポジトリ名とIssue番号を別々の`in`で絞るので、取れる行には他の組み合わせも混ざりうる。
 * 使うのは鍵の集合として引き当てるときだけなので、混ざっていても結果は変わらない。
 */
async function selectPendingSessionRequestKeys(
  targets: readonly { repositoryFullName: string; issueNumber: number }[],
  now: Date,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (targets.length === 0) return keys;

  const where = {
    status: "WAITING" as const,
    expiresAt: { gt: now },
    repositoryFullName: { in: [...new Set(targets.map((t) => t.repositoryFullName))] },
    issueNumber: { in: [...new Set(targets.map((t) => t.issueNumber))] },
  };
  const select = { repositoryFullName: true, issueNumber: true } as const;
  const [plans, questions] = await Promise.all([
    db.sessionPlanRequest.findMany({ where, select }),
    db.sessionQuestionRequest.findMany({ where, select }),
  ]);
  for (const row of [...plans, ...questions]) {
    keys.add(sessionRequestKey(row.repositoryFullName, row.issueNumber));
  }
  return keys;
}

/** 計画提示からこれだけ経ったら、レビューが届かなくても保留をやめる（ジョブが詰まった場合の保険） */
export const PLAN_REVIEW_PUSH_HOLD_MAX_MS = 15 * 60 * 1000;

/**
 * 計画待ちの作成から、計画レビューのジョブが積まれるのを待つ時間（#3709）。
 * `postSessionPlan`は`00.check-user`を付けてからジョブを積むため、その間に走った巡回は
 * ジョブを引けない。積まれなかった計画（Codex等）でも、通知はこの時間だけ遅れるだけ
 */
export const PLAN_REVIEW_JOB_ENQUEUE_WAIT_MS = 60 * 1000;

/**
 * 自動反映（`decidedByUserId=null`の修正）の決定から、GitHub側のラベル解除がDBへ届くのを待つ時間
 * （#3709）。決定は計画待ちを先に`REVISION_REQUESTED`にしてからラベルを外すので、その間は
 * 保留も計画待ちも無いままDBに`00.check-user`だけが残り、経過時間の判定で送られてしまう
 */
export const PLAN_REVIEW_REFLECT_PUSH_HOLD_MS = 2 * 60 * 1000;

/**
 * **計画レビューの自動反映を待って、通知を保留するIssue**の鍵を返す（#3616）。
 *
 * 保留するのは次のどれか。**受け手の居ない保留は、通知が遅れるだけで何も起こらない**ので、
 * 自動反映が実際に起こりうる場合に限る。
 *
 * - **レビューが作成中**: 期限内の`WAITING`の計画待ちがあり
 *   （「アプリで答える」ON・待ち時間0のセッションは待ちが作られないので対象外）、計画の提示から
 *   `PLAN_REVIEW_PUSH_HOLD_MAX_MS`以内で、計画レビューのジョブがClaude Codeのもので作成中
 *   （`isPlanReviewJobCreating`。実行中、または成功から猶予内で、採否`planReviewDecidedAt`が未決定）。
 *   **反映済みでも保留する**（#3648。自動反映は指摘がなくなるまで繰り返す）が、**今の計画より後に
 *   積まれた**ジョブだけを見る。積まれていない・失敗・見送りなら保留しない
 * - **ジョブが積まれるのを待つ**（#3709）: 計画待ちの作成から`PLAN_REVIEW_JOB_ENQUEUE_WAIT_MS`以内で、
 *   **その計画待ちより後に積まれたジョブがまだ無い**。2周目以降は前の周のジョブが残るので、
 *   「ジョブが1件も無い」ではなく「今の計画より後のジョブが無い」で見る
 * - **自動反映の直後**（#3709）: 自動反映の決定から`PLAN_REVIEW_REFLECT_PUSH_HOLD_MS`以内で、
 *   その後に新しい計画待ちが無い
 *
 * **3つとも理由ラベルで絞らない**（#3726。作成中も絞らない）。`00.check-user`は理由ラベルより先に付く
 * （`dispatch/check-user-labels.ts`）ので、付与直後の巡回では理由がまだ`plan`と読めない。
 * 計画待ちがあれば理由は計画と確定している
 */
async function selectPlanReviewHoldKeys(
  targets: readonly {
    repositoryFullName: string;
    issueNumber: number;
    labels: readonly { name: string }[];
  }[],
  now: Date,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (targets.length === 0) return keys;

  const scope = {
    repositoryFullName: { in: [...new Set(targets.map((t) => t.repositoryFullName))] },
    issueNumber: { in: [...new Set(targets.map((t) => t.issueNumber))] },
  };
  const [waiting, jobs, reflected] = await Promise.all([
    db.sessionPlanRequest.findMany({
      where: {
        ...scope,
        status: "WAITING",
        expiresAt: { gt: now },
        createdAt: { gt: new Date(now.getTime() - PLAN_REVIEW_PUSH_HOLD_MAX_MS) },
      },
      select: { repositoryFullName: true, issueNumber: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.dispatchJob.findMany({
      where: { ...scope, kind: "PLAN_REVIEW" },
      orderBy: { createdAt: "desc" },
      select: {
        repositoryFullName: true,
        issueNumber: true,
        agent: true,
        status: true,
        createdAt: true,
        finishedAt: true,
        planReviewDecidedAt: true,
      },
    }),
    db.sessionPlanRequest.findMany({
      where: {
        ...scope,
        status: "REVISION_REQUESTED",
        decidedByUserId: null,
        decidedAt: { gt: new Date(now.getTime() - PLAN_REVIEW_REFLECT_PUSH_HOLD_MS) },
      },
      select: { repositoryFullName: true, issueNumber: true, decidedAt: true },
    }),
  ]);

  // 同じIssueに計画待ちが複数あれば新しい方（昇順で並べて後勝ちにする）
  const waitingCreatedAt = new Map(
    waiting.map((r) => [sessionRequestKey(r.repositoryFullName, r.issueNumber), r.createdAt]),
  );

  // 自動反映の直後。その後に新しい計画待ちが出ていれば、そちらを下の判定へ任せる
  for (const row of reflected) {
    if (!row.decidedAt) continue;
    const key = sessionRequestKey(row.repositoryFullName, row.issueNumber);
    const next = waitingCreatedAt.get(key);
    if (!next || next < row.decidedAt) keys.add(key);
  }

  // Issueごとの最新ジョブ（新しい順なので、最初に当たったものがそのIssueの最新）
  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const key = sessionRequestKey(job.repositoryFullName, job.issueNumber);
    if (!latestJob.has(key)) latestJob.set(key, job);
  }

  for (const [key, planCreatedAt] of waitingCreatedAt) {
    // **今の計画より前に積まれたジョブのレビューは待たない**（#3648）。出し直した計画のレビューが
    // 積まれなかったときに、前の周の成功済みジョブで保留し続けない。**計画待ちはレビューのジョブより
    // 先に作られる前提**（`POST /api/dispatch/sessions/plan`。#3697）
    const job = latestJob.get(key);
    const current = job && job.createdAt >= planCreatedAt ? job : null;

    if (!current) {
      // まだ積まれていないだけかもしれない（#3709）
      if (now.getTime() - planCreatedAt.getTime() < PLAN_REVIEW_JOB_ENQUEUE_WAIT_MS) keys.add(key);
      continue;
    }
    if (current.agent !== "claude") continue;
    const creating = isPlanReviewJobCreating(
      {
        status: current.status as DispatchJobStatus,
        finishedAt: current.finishedAt?.toISOString() ?? null,
        planReviewDecidedAt: current.planReviewDecidedAt?.toISOString() ?? null,
      },
      now,
    );
    if (creating) keys.add(key);
  }
  return keys;
}

/**
 * 「これから送る」ことを先に記録して席を取る（#2300）。取れたらtrue。
 *
 * **巡回は同時に何本も走る。** 呼び口は`POST /api/dispatch/claim`（pollerが30秒ごと）と
 * GitHubのWebhook受け口の2つで、Webhookは`00.check-user`が付くときに何件かまとめて届く
 * （ラベルの付与・理由ラベルの付与・計画コメントの投稿）。送ってから記録を付けていると、
 * その隙間に入った別の巡回も同じIssueを未送信として拾い、**同じ通知が続けて2件届く**。
 *
 * `updateMany`の更新件数で確定させる楽観的な取り方は、ジョブの払い出し
 * （`dispatch/jobs.ts`の`claimCandidates`）と同じ。`where`に`checkUserPushSentAt: null`を
 * 含めるので、取り合いが起きても勝つのは1本だけで、トランザクションもロックも要らない。
 *
 * **送信の成否で記録を戻さない。** 一時的な失敗のために巡回のたび鳴らし直すより、
 * 1件落とす方が軽い（次の確認待ちは同じ経路で届く）。`skip`（古すぎるもの）も同じ口を
 * 通し、送らずに記録だけ付ける。
 */
async function reserveCheckUserPush(issueId: string, now: Date): Promise<boolean> {
  const result = await db.issue.updateMany({
    where: { id: issueId, checkUserPushSentAt: null },
    data: { checkUserPushSentAt: now },
  });
  return result.count > 0;
}

/**
 * 待ち時間の過ぎた確認待ちをまとめて通知する。
 *
 * **常駐プロセスは置かない**（`runManualStepVerificationPatrol`と同じ方針）。呼ぶのは
 * サブPCのpollerが叩く`POST /api/dispatch/claim`（30秒ごと。ブラウザを開いていなくても回る）と
 * GitHubのWebhook受け口の2か所で、どちらも失敗しても本来の処理を止めない。
 *
 * 送った件数を返す（呼び出し側は使わないが、テストと調査のため）。
 */
export async function sweepCheckUserPushNotifications(now: Date = new Date()): Promise<number> {
  if (!isPushConfigured()) return 0;

  // **待ち時間の下限で絞らない**（#2238）。計画・質問の待ちがあるものは待たずに送るため、
  // 付いたばかりの確認待ちもここに含める必要がある。待ち時間の判断は
  // `decideCheckUserPush`が1か所で持ち、まだ早いものは`wait`として次の巡回へ回る
  const candidates = await db.issue.findMany({
    where: {
      state: "OPEN",
      checkUserPushSentAt: null,
      checkUserLabeledAt: { not: null, lte: now },
    },
    include: {
      labels: { select: { name: true } },
      repository: { select: { id: true, fullName: true, installationId: true } },
    },
    orderBy: { checkUserLabeledAt: "asc" },
    take: SWEEP_BATCH_SIZE,
  });

  const pendingRequestKeys = await selectPendingSessionRequestKeys(
    candidates.map((issue) => ({
      repositoryFullName: issue.repository.fullName,
      issueNumber: issue.number,
    })),
    now,
  );

  const planReviewHoldKeys = await selectPlanReviewHoldKeys(
    candidates.map((issue) => ({
      repositoryFullName: issue.repository.fullName,
      issueNumber: issue.number,
      labels: issue.labels,
    })),
    now,
  );

  let sent = 0;
  for (const issue of candidates) {
    if (!issue.checkUserLabeledAt) continue;
    const key = sessionRequestKey(issue.repository.fullName, issue.number);
    const decision = decideCheckUserPush({
      labels: issue.labels,
      checkUserLabeledAt: issue.checkUserLabeledAt,
      hasPendingSessionRequest: pendingRequestKeys.has(key),
      holdForPlanReview: planReviewHoldKeys.has(key),
      now,
    });
    if (decision === "wait") continue;

    if (decision === "send") {
      // 宛先は「そのリポジトリのインストールに紐づくユーザー」の購読すべて。
      // 種別単位のON/OFFは今回の範囲外（購読の有無だけで決める）。
      //
      // **そのリポジトリを非表示にしているユーザーへは送らない**（#2279）。非表示にすると
      // 一覧にも確認待ちビューにも出なくなるため、通知だけが届いても開いた先に何も無い
      //
      // **「いまは実施しない」として伏せているユーザーへも送らない**（#2398）。判定は
      // 画面側（`lib/snooze.ts`）と同じで、`until`がnull（手動解除まで）か未来のものだけを
      // 効いている保留として見る
      const subscriberWhere = {
        userInstallations: { some: { installationId: issue.repository.installationId } },
        hiddenRepositories: { none: { repositoryId: issue.repository.id } },
      };
      const snoozedWhere = {
        snoozedItems: {
          some: {
            repositoryId: issue.repository.id,
            kind: "ISSUE" as const,
            number: issue.number,
            OR: [{ until: null }, { until: { gt: now } }],
          },
        },
      };
      const [targets, snoozedSubscriberCount] = await Promise.all([
        db.pushSubscription.findMany({
          where: { user: { ...subscriberWhere, NOT: snoozedWhere } },
          select: { id: true, endpoint: true, p256dh: true, auth: true },
        }),
        db.pushSubscription.count({ where: { user: { ...subscriberWhere, ...snoozedWhere } } }),
      ]);

      // **宛先が保留のせいで全員消えたときは、席を取らずに次の巡回へ回す**（#2398）。
      // `checkUserPushSentAt`は一度立つと`00.check-user`が付き直すまで戻らないので、
      // ここで送信済みにすると保留を解除しても二度と鳴らない。保留が解ければ、この巡回が
      // そのまま拾って送る（`decideCheckUserPush`は`checkUserLabeledAt`しか見ない）
      if (targets.length === 0 && snoozedSubscriberCount > 0) continue;

      // **送る前に「送信済み」を立てて席を取る**（#2300）。取れなかったら、同じIssueを
      // 別の巡回が既に掴んでいるので何もしない
      if (!(await reserveCheckUserPush(issue.id, now))) continue;

      const result = await sendPushNotification(
        targets,
        buildCheckUserPushPayload({
          githubIssueId: issue.githubIssueId,
          number: issue.number,
          title: issue.title,
          repositoryFullName: issue.repository.fullName,
          labels: issue.labels,
        }),
      );
      sent += result.sent;
      continue;
    }

    // `skip`（古すぎるもの）は送らずに記録だけ付ける
    await reserveCheckUserPush(issue.id, now);
  }

  return sent;
}
