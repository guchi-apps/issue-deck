import type { DispatchHost, DispatchJob } from "@prisma/client";

import { DISPATCH_CONCURRENCY_DEFAULT } from "@/lib/app-settings";
import { db } from "@/lib/db";
import type { DispatchHostMetrics } from "@/lib/dispatch/host-metrics";
import { listDispatchSessions } from "@/lib/dispatch/sessions";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  buildDispatchActiveKey,
  describeDispatchControlTimeout,
  describeDispatchEnqueueRejection,
  describeCrossRepoQuestionRejection,
  describeDispatchReportLost,
  describeDispatchTimeout,
  describeSessionControlRejection,
  DISPATCH_CLAIM_TIMEOUT_MS,
  DISPATCH_CONTROL_QUEUE_TIMEOUT_MS,
  DISPATCH_HEARTBEAT_TIMEOUT_MS,
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  isActiveDispatchJobStatus,
  isDispatchHostOnline,
  isSessionLaunchJobKind,
  normalizeDispatchHostRepositories,
  parseDispatchHostRepositories,
  resolveCrossRepoQuestionRejection,
  resolveDispatchConcurrency,
  resolveSessionControlRejection,
  SESSION_CONTROL_JOB_KINDS,
  SESSION_LAUNCH_JOB_KINDS,
  type CrossRepoQuestionRejection,
  type DispatchEnqueueRejection,
  type DispatchHostView,
  type DispatchJobKind,
  type DispatchJobStatus,
  type DispatchJobView,
  type DispatchReportStatus,
  type SessionControlJobKind,
  type SessionControlRejection,
} from "@/lib/dispatch/dispatch-job";

/**
 * ディスパッチのジョブキュー（#1179）のDB操作。
 *
 * 方式はpull型で、issue-deckはジョブを置くだけ。サブPCのpollerが
 * `POST /api/dispatch/claim`で取りに来る（VPSがtailnetに未参加で、Tailscale SSHに
 * forced commandが無いため。#1176）。
 *
 * **定期実行の仕組みを持たない。** タイムアウトはenqueue・claim・一覧取得のたびに
 * `expireStaleDispatchJobs`が掃く遅延評価にしている。VPS上にcronやワーカーを増やすと、
 * それ自体の死活監視が要るようになる。ポーリングが60秒間隔で来るぶん、掃く機会は十分にある。
 */

// 画面へ返す形（`DispatchJobView`・`DispatchHostView`）の定義は`dispatch-job.ts`にある。
// このモジュールはPrismaクライアントを読み込むため、クライアントコンポーネント（#1180）から
// importできない。型だけを再輸出して、サーバー側の呼び出し元が経路を意識せずに使えるようにする。
export type { DispatchHostView, DispatchJobView };

/**
 * @param issueTitle Issueのタイトル（#1519）。**既定は`null`。**
 *   引けるのは一覧取得（`listDispatchState`）だけで、そこは1クエリでまとめて解決する。
 *   ジョブを積んだ直後の戻り値のためだけにenqueueごとへクエリを1本足すことはしない
 *   （画面は積んだジョブを楽観的に差し込むが、次の取得＝未完了がある間は5秒でタイトルが埋まる）。
 */
/**
 * DBの行を画面向けの形へ。
 *
 * **引き当てたIssue（`issue`）はオブジェクトで受け取る。** 位置引数で足すと、`jobs.map(toJobView)`と
 * 書いたときに`Array#map`の第2引数（index）がそのまま入る事故が起きる（`listDispatchState`の
 * コメント参照）。
 */
function toJobView(
  job: DispatchJob,
  issue: { id: string; title: string } | null = null,
): DispatchJobView {
  return {
    id: job.id,
    repositoryFullName: job.repositoryFullName,
    issueNumber: job.issueNumber,
    issueTitle: issue?.title ?? null,
    issueId: issue?.id ?? null,
    targetHost: job.targetHost,
    kind: job.kind,
    status: job.status,
    message: job.message,
    instruction: job.instruction,
    tmuxSessionName: job.tmuxSessionName,
    queuePriority: job.queuePriority,
    createdAt: job.createdAt.toISOString(),
    claimedAt: job.claimedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function toHostView(host: DispatchHost, now: Date): DispatchHostView {
  return {
    name: host.name,
    repositories: parseDispatchHostRepositories(host.repositories),
    contractVersion: host.contractVersion,
    online: isDispatchHostOnline(host.lastSeenAt, now),
    lastSeenAt: host.lastSeenAt.toISOString(),
    screenshotCapable: host.screenshotCapable,
    sessionControlCapable: host.sessionControlCapable,
    instructionCapable: host.instructionCapable,
    crossRepoQuestionCapable: host.crossRepoQuestionCapable,
    maxSessions: host.maxSessions,
    liveSessions: host.liveSessions,
    // 5列は「まとめて入るかまとめてnullか」で保存されている（#1567）。読むときも同じ扱いにし、
    // 1つでも欠けていれば使用率そのものを出さない（欠けた項目が0＝空きに見えるのを避ける）。
    // **SWAPの2列はこの5列に含めない**（#1624。欠けていてもCPU・メモリ・ディスクは出す）
    metrics:
      host.cpuPercent === null ||
      host.memoryUsedMb === null ||
      host.memoryTotalMb === null ||
      host.diskUsedGb === null ||
      host.diskTotalGb === null
        ? null
        : {
            cpuPercent: host.cpuPercent,
            memoryUsedMb: host.memoryUsedMb,
            memoryTotalMb: host.memoryTotalMb,
            diskUsedGb: host.diskUsedGb,
            diskTotalGb: host.diskTotalGb,
            // SWAPの2列は上の5列と別扱い（#1624）。**片方だけ入っていれば対でnullへ倒す。**
            // 使用量だけが残った状態を「総量0のSWAPが埋まっている」と読ませない
            swapUsedMb: host.swapTotalMb === null ? null : host.swapUsedMb,
            swapTotalMb: host.swapUsedMb === null ? null : host.swapTotalMb,
          },
  };
}

async function getDispatchConcurrency(): Promise<number> {
  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return setting?.dispatchConcurrency ?? DISPATCH_CONCURRENCY_DEFAULT;
}

/**
 * 期限切れのジョブをTIMEOUTへ落とす。**呼ばれたときにだけ動く**（上のコメント参照）。
 *
 * `activeKey`をnullへ戻すのが要点で、これをしないと同じIssueに次のジョブを積めなくなる。
 * サブPCが落ちたまま復帰しない場合に、ジョブが滞留して以降の起動を封じるのを防ぐ。
 *
 * **起動ジョブは落とす前にセッションを見る**（#1620）。詳細は`rescueLaunchedJobs`。
 */
export async function expireStaleDispatchJobs(now: Date = new Date()): Promise<number> {
  const claimDeadline = new Date(now.getTime() - DISPATCH_CLAIM_TIMEOUT_MS);
  const heartbeatDeadline = new Date(now.getTime() - DISPATCH_HEARTBEAT_TIMEOUT_MS);
  const controlDeadline = new Date(now.getTime() - DISPATCH_CONTROL_QUEUE_TIMEOUT_MS);

  const stale = await db.dispatchJob.findMany({
    where: {
      OR: [
        { status: "CLAIMED", claimedAt: { lt: claimDeadline } },
        { status: "RUNNING", heartbeatAt: { lt: heartbeatDeadline } },
        // heartbeatが一度も届かないままRUNNINGになっている場合はstartedAtで測る
        { status: "RUNNING", heartbeatAt: null, startedAt: { lt: heartbeatDeadline } },
        // 取りに来られないまま古びた制御ジョブ（#1332）。**起動ジョブと違い、待たせるほど
        // 危険になる**（何時間も後に届いた`C-c`は、そのとき走っている別の作業を止める）
        {
          status: "QUEUED",
          kind: { in: [...SESSION_CONTROL_JOB_KINDS] },
          createdAt: { lt: controlDeadline },
        },
      ],
    },
    select: {
      id: true,
      status: true,
      kind: true,
      targetHost: true,
      repositoryFullName: true,
      issueNumber: true,
      tmuxSessionName: true,
    },
  });

  const launchedSessions = await findSessionsForStaleLaunchJobs(stale, now);

  let expired = 0;
  for (const job of stale) {
    if (job.status !== "CLAIMED" && job.status !== "RUNNING" && job.status !== "QUEUED") continue;
    const launched = launchedSessions.get(staleJobSessionKey(job));
    // 掃いている間にpollerが報告してくる可能性があるため、状態を条件に含めて更新する。
    // 0件で落ちるのは「先に報告が届いた」ということなので、そのまま無視してよい。
    const result = await db.dispatchJob.updateMany({
      where: { id: job.id, status: job.status },
      data: launched
        ? {
            status: "SUCCEEDED",
            activeKey: null,
            finishedAt: now,
            // 報告が届いていればここに入っていた値。実行ログ（`tmux attach`）の在り処なので補う
            tmuxSessionName: job.tmuxSessionName ?? launched,
            message: describeDispatchReportLost(launched),
          }
        : {
            status: "TIMEOUT",
            activeKey: null,
            finishedAt: now,
            message:
              job.status === "QUEUED"
                ? describeDispatchControlTimeout()
                : describeDispatchTimeout(job.status),
          },
    });
    expired += result.count;
  }
  return expired;
}

type StaleDispatchJob = {
  status: DispatchJobStatus;
  kind: DispatchJobKind;
  targetHost: string;
  repositoryFullName: string;
  issueNumber: number;
};

function staleJobSessionKey(job: StaleDispatchJob): string {
  return `${job.targetHost} ${job.repositoryFullName} ${job.issueNumber}`;
}

/**
 * 期限切れの起動ジョブのうち、**実際にはセッションが立っているもの**を拾う（#1620）。
 * 戻り値はジョブの`staleJobSessionKey`→ tmuxセッション名。
 *
 * pollerは`succeeded`の報告に失敗しても再送を諦める（`report_job`）。issue-deckが一時的に
 * 応答しなかっただけでも、tmuxセッションは立っているのにジョブは`RUNNING`のまま残り、
 * 10分後にここでタイムアウトになる。その結果、**同じIssueが実行キューの「実行中」
 * （セッション一覧）と「直近の失敗」に同時に出る**（#1620で実際に起きた。
 * `journalctl`に「ジョブ状態の報告に失敗しました（… → succeeded）」が残っていた）。
 *
 * **セッションの報告が新しいものだけを見る。** pollerごと落ちている場合、`ALIVE`の行は
 * そのまま古びて残る。判定材料が古いまま「起動できていた」と決めると、本当に落ちた起動を
 * 成功として隠すことになるため、ホストの生存判定（`DISPATCH_HOST_ONLINE_WINDOW_MS`）と
 * 同じ窓の内側で報告されているセッションに限る。
 */
async function findSessionsForStaleLaunchJobs(
  stale: readonly StaleDispatchJob[],
  now: Date,
): Promise<Map<string, string>> {
  // 制御ジョブ（枠外で走り、tmuxを1回叩いて終わる）はセッションを立てないので対象外
  const launchJobs = stale.filter(
    (job) =>
      isSessionLaunchJobKind(job.kind) && (job.status === "CLAIMED" || job.status === "RUNNING"),
  );
  if (launchJobs.length === 0) return new Map();

  const sessions = await db.dispatchSession.findMany({
    where: {
      state: "ALIVE",
      lastReportedAt: { gte: new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS) },
      OR: launchJobs.map((job) => ({
        host: job.targetHost,
        repositoryFullName: job.repositoryFullName,
        issueNumber: job.issueNumber,
      })),
    },
    select: { host: true, repositoryFullName: true, issueNumber: true, tmuxSessionName: true },
  });

  return new Map(
    sessions.map((session) => [
      `${session.host} ${session.repositoryFullName} ${session.issueNumber}`,
      session.tmuxSessionName,
    ]),
  );
}

export type EnqueueDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: DispatchEnqueueRejection; message: string };

/**
 * ジョブを積む（画面から呼ぶ）。
 *
 * **実行できない組み合わせはここで弾き、理由を返す**（#1179のコメントの決定
 * 「ディスパッチ前に弾く」）。投げたのに何も起きない状態を作らないための要。
 */
export async function enqueueDispatchJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueDispatchJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const reject = (
    rejection: DispatchEnqueueRejection,
    session?: Pick<DispatchSessionView, "host" | "tmuxSessionName">,
  ): EnqueueDispatchJobResult => ({
    ok: false,
    rejection,
    message: describeDispatchEnqueueRejection(rejection, {
      hostName: params.hostName,
      repositoryFullName: params.repositoryFullName,
      session,
    }),
  });

  if (!host) return reject("host_unknown");
  if (!isDispatchHostOnline(host.lastSeenAt, now)) return reject("host_offline");
  if (!parseDispatchHostRepositories(host.repositories).includes(params.repositoryFullName)) {
    return reject("repository_not_runnable");
  }

  // 既に動いているセッションがあれば積ませない（#1311）。**画面側の`findBlockingSession`と
  // 同じ判定をここでも行う。** 一括投入（`bulk-dispatch-bar.tsx`）は個々のIssueの判定を
  // API側へ委ねているため、画面だけに置くとそちらが素通りする。
  //
  // 判定の材料がDBの行かビューかの違いだけで、中身は`findBlockingSession`と揃えている
  // （`ALIVE`に限る・所属ホストが応答している場合だけ止める・ホストは問わない）。ホストの
  // 生存判定を`host.online`ではなく`isDispatchHostOnline`で行うのは、上のhost_offlineの
  // 判定と同じ理由（サーバー側は生の`lastSeenAt`を持っている）。
  const aliveSession = await db.dispatchSession.findFirst({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      state: "ALIVE",
    },
    orderBy: { lastReportedAt: "desc" },
  });
  if (aliveSession) {
    // 別ホストで動いている場合もあるため、積み先のホストではなくセッションの所属ホストを見る
    const sessionHost =
      aliveSession.host === host.name
        ? host
        : await db.dispatchHost.findUnique({ where: { name: aliveSession.host } });
    if (sessionHost && isDispatchHostOnline(sessionHost.lastSeenAt, now)) {
      return reject("session_alive", aliveSession);
    }
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        status: "QUEUED",
        activeKey: buildDispatchActiveKey(params.repositoryFullName, params.issueNumber),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    // activeKeyのunique制約違反＝同じIssueの未完了ジョブが既にある。二重クリックの競合を
    // 含めてここで確実に止まる（アプリ側の存在チェックだけでは競合をすり抜ける）
    return reject("already_queued");
  }
}

export type EnqueueCrossRepoQuestionJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: CrossRepoQuestionRejection; message: string };

/**
 * 複数リポジトリ横断の質問セッション（#1454）を積む。
 *
 * **起動ジョブ（`enqueueDispatchJob`）とは判定が違う。** 記録先リポジトリがサブPCに
 * cloneされているかは問わない（worktreeを作らず、記録先へは`gh issue comment`で書くだけ）。
 * 代わりに「参照できるリポジトリが1件以上あるか」と「pollerが横断質問に対応しているか」を見る。
 */
export async function enqueueCrossRepoQuestionJob(params: {
  /** 質問Issueの置き場所（`question`リポジトリなど）。**参照範囲とは無関係** */
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueCrossRepoQuestionJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const reject = (rejection: CrossRepoQuestionRejection): EnqueueCrossRepoQuestionJobResult => ({
    ok: false,
    rejection,
    message: describeCrossRepoQuestionRejection(rejection, { hostName: params.hostName }),
  });

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });

  // そのIssueで既にセッションが動いていれば積ませない（#1311と同じ層）。判定の材料が
  // DBの行かビューかの違いだけで、中身は`findBlockingSession`と揃えている
  const aliveSession = await db.dispatchSession.findFirst({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      state: "ALIVE",
    },
    orderBy: { lastReportedAt: "desc" },
  });
  const sessionHost = aliveSession
    ? aliveSession.host === host?.name
      ? host
      : await db.dispatchHost.findUnique({ where: { name: aliveSession.host } })
    : null;
  const blockingSession =
    aliveSession && sessionHost && isDispatchHostOnline(sessionHost.lastSeenAt, now)
      ? aliveSession
      : null;

  // 判定そのものは画面側と同じ関数を使う（片方だけで持つと、押せるのに拒否される状態が生まれる）
  const rejection = resolveCrossRepoQuestionRejection({
    host: host
      ? {
          online: isDispatchHostOnline(host.lastSeenAt, now),
          crossRepoQuestionCapable: host.crossRepoQuestionCapable,
          repositories: parseDispatchHostRepositories(host.repositories),
        }
      : null,
    // 二重投入はactiveKeyのunique制約が確実に止める（下のcatch）。ここでは先読みしない
    hasActiveJob: false,
    blockingSession,
  });
  if (rejection) return reject(rejection);

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        kind: "CROSS_REPO_QUESTION",
        status: "QUEUED",
        // **実装ジョブとは名前空間を分ける**（`cross_repo_question:owner/repo#番号`）。同じ
        // 質問Issueへの二重起動だけを止め、実装中のIssueへ質問を積むことは妨げない
        activeKey: buildDispatchActiveKey(
          params.repositoryFullName,
          params.issueNumber,
          "CROSS_REPO_QUESTION",
        ),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    return reject("already_queued");
  }
}

export type EnqueueSessionControlJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: SessionControlRejection; message: string };

/**
 * 走っているセッションへの操作（停止・終了・追加指示）を積む（#1332・#1012）。
 *
 * **起動ジョブと同じキューに載せる。** 受信経路・認証・状態報告・タイムアウトの一式が
 * そのまま使えるため、pollerにもissue-deckにも新しい経路を作らずに済む。
 *
 * **対象は`DispatchSession`にある（＝pollerが報告してきた）セッションだけ。** 画面が知らない
 * セッション名を受け取ってtmuxへ渡す経路は作らない。実行するpoller側でも、ジョブの
 * リポジトリとIssue番号からセッション名を組み立て直して突き合わせる（多層防御）。
 */
export async function enqueueSessionControlJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  /** **`INTERRUPT`・`KILL`・`INSTRUCTION`に限る。** 質問ジョブ（#1294）はこの経路に載らない */
  kind: SessionControlJobKind;
  /**
   * 追加指示の本文（#1012）。**`kind`が`INSTRUCTION`のときは必須**で、呼び出し元が
   * `parseSessionInstruction`を通した値を渡す（検証はpoller側でも重ねて行う）。
   */
  instruction?: string | null;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueSessionControlJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const reject = (rejection: SessionControlRejection): EnqueueSessionControlJobResult => ({
    ok: false,
    rejection,
    message: describeSessionControlRejection(rejection, {
      hostName: params.hostName,
      kind: params.kind,
    }),
  });

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const session = await db.dispatchSession.findFirst({
    where: {
      host: params.hostName,
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
    },
    orderBy: { lastReportedAt: "desc" },
  });

  // 判定そのものは画面側と同じ関数を使う（片方だけで持つと、押せるのに拒否される状態が生まれる）。
  // ホストの生存判定だけはサーバー側が生の`lastSeenAt`を持っているため、ここで解決してから渡す
  const rejection = resolveSessionControlRejection({
    host: host
      ? {
          online: isDispatchHostOnline(host.lastSeenAt, now),
          sessionControlCapable: host.sessionControlCapable,
          instructionCapable: host.instructionCapable,
        }
      : null,
    session,
    kind: params.kind,
    // 二重投入はactiveKeyのunique制約が確実に止める（下のcatch）。ここでは先読みしない
    hasActiveControlJob: false,
  });
  if (rejection) return reject(rejection);

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        kind: params.kind,
        status: "QUEUED",
        activeKey: buildDispatchActiveKey(
          params.repositoryFullName,
          params.issueNumber,
          params.kind,
        ),
        requestedByUserId: params.requestedByUserId,
        // 追加指示の本文（#1012）。それ以外の種別ではnullのまま
        instruction: params.kind === "INSTRUCTION" ? (params.instruction ?? null) : null,
        // どのセッションを指した操作かを残す。**pollerはこの名前をそのまま使わず突き合わせる**
        tmuxSessionName: session?.tmuxSessionName ?? null,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    // activeKeyのunique制約違反＝同じ種別の未処理の操作が既にある。スマホでの連打が
    // そのぶんの`C-c`になるのをここで止める
    return reject("already_queued");
  }
}

/**
 * サブPCがジョブを取る。
 *
 * **`updateMany`の更新件数で確定させる楽観的な取り方**にしている。`where`に
 * `status: QUEUED`を含めるため、取り合いが起きても片方が0件で落ちるだけで、
 * トランザクションもロックも要らない。
 *
 * 制御ジョブ（#1332）は**起動ジョブより先に・同時実行数の枠外で**払い出す。tmuxを1回叩くだけで
 * 重くないうえ、起動待ちの後ろに並ばせると**止めたいときほど待たされる**（1巡で取る本数は
 * 既定1本なので、待っている起動ジョブの数だけポーリング間隔が積み上がる）。
 */
/** 1巡で払い出す制御ジョブの上限。溜まっていても1巡で捌ける範囲に留める */
const MAX_CONTROL_JOBS_PER_CLAIM = 10;

export async function claimDispatchJobs(params: {
  hostName: string;
  maxJobs: number;
  now?: Date;
}): Promise<DispatchJobView[]> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const limit = resolveDispatchConcurrency(
    await getDispatchConcurrency(),
    host?.maxConcurrency ?? null,
  );

  const claimed: DispatchJobView[] = [];

  // **セッションの操作に対応していないpollerには制御ジョブを配らない**（#1332）。
  // 古いpollerは`kind`を読まないため、受け取ると起動ジョブとして解釈して
  // セッションを立ててしまう（「閉じる」を押して起動する）。
  //
  // **申告は種別で分けて見る**（#1012）。停止・終了（固定の`C-c`と`kill-session`）に対応した
  // pollerでも、内容のある文字列を送る3段階プロトコルは別の実装で、そちらは
  // `instructionCapable`を申告したホストにだけ配る（申告していないpollerは未知の種別として
  // `failed`で返すため、配ると追加指示が必ず失敗として残る）。
  const controlKinds: DispatchJobKind[] = [];
  if (host?.sessionControlCapable === true) controlKinds.push("INTERRUPT", "KILL");
  if (host?.instructionCapable === true) controlKinds.push("INSTRUCTION");
  if (controlKinds.length > 0) {
    const controls = await db.dispatchJob.findMany({
      where: {
        targetHost: params.hostName,
        status: "QUEUED",
        kind: { in: controlKinds },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_CONTROL_JOBS_PER_CLAIM,
    });
    claimed.push(...(await claimCandidates(controls, params.hostName, now)));
  }

  // **横断質問（#1454）は起動ジョブと同じ枠で扱う。** tmuxセッションを立てるジョブなので、
  // 制御ジョブのように枠外へ出すとセッション本数の見積もりが崩れる。対応を申告していない
  // pollerには配らない（古いpollerは未知の種別として`failed`で返すため、質問が必ず失われる）
  const launchKinds: DispatchJobKind[] = ["LAUNCH"];
  if (host?.crossRepoQuestionCapable === true) launchKinds.push("CROSS_REPO_QUESTION");

  const running = await db.dispatchJob.count({
    where: {
      targetHost: params.hostName,
      status: { in: ["CLAIMED", "RUNNING"] },
      // 制御ジョブは枠を消費しない（上のコメント）。**画面（`summarizeDispatchQueue`）も
      // 同じ集合を数える**（#1544）
      kind: { in: [...SESSION_LAUNCH_JOB_KINDS] },
    },
  });
  const available = Math.min(limit - running, params.maxJobs);
  if (available <= 0) return claimed;

  // **質問ジョブ（`QUESTION`、#1294）はどのpollerにも配らない。** 種別を明示して引くため
  // ここに混ざることは無いが、意図として書いておく。現行のpollerは未知の種別を
  // 「未知のジョブ種別です」として`failed`で返す（`scripts/subpc-dispatch-poller.sh`）ので、
  // 実行側が来ていない段階で配ると質問が必ず失敗として残る。払い出しはStep 3（別Issue）で、
  // poller側の対応申告（`sessionControlCapable`と同じ形）とセットで開ける。
  // **並びは`queuePriority`降順 →`createdAt`昇順**（#1541）。既定は全件0なので、既存の
  // 「積んだ順」がそのまま残る。画面（`summarizeDispatchQueue`）も同じ並びで出すので、
  // 見えている順番と実際に走る順番が一致する。
  const candidates = await db.dispatchJob.findMany({
    where: { targetHost: params.hostName, status: "QUEUED", kind: { in: launchKinds } },
    orderBy: [{ queuePriority: "desc" }, { createdAt: "asc" }],
    take: available,
  });
  claimed.push(...(await claimCandidates(candidates, params.hostName, now)));
  return claimed;
}

/** 候補を1件ずつ`QUEUED`を条件に更新して確定させる（取り合いは0件で落ちるだけ） */
async function claimCandidates(
  candidates: DispatchJob[],
  hostName: string,
  now: Date,
): Promise<DispatchJobView[]> {
  const claimed: DispatchJobView[] = [];
  for (const candidate of candidates) {
    const result = await db.dispatchJob.updateMany({
      where: { id: candidate.id, status: "QUEUED" },
      data: { status: "CLAIMED", claimedByHost: hostName, claimedAt: now },
    });
    if (result.count === 0) continue;
    claimed.push(
      toJobView({
        ...candidate,
        status: "CLAIMED",
        claimedByHost: hostName,
        claimedAt: now,
      }),
    );
  }
  return claimed;
}

export type ReportDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; reason: "not_found" | "wrong_host" | "already_finished" };

/**
 * pollerからの状態報告を受ける。
 *
 * **`succeeded`が意味するのは「tmuxセッションが立ち上がった」まで**で、実装の完了ではない
 * （以降の進捗はProject Statusが持つ唯一の正）。ここで実装完了まで追おうとすると、
 * セッションの終了検知という別の仕組みが要るうえ、Project Statusと情報が重複する。
 */
/** 報告の値と、DBへ入れる終了状態の対応。`running`だけは扱いが違うので含めない */
const REPORT_STATUS_TO_JOB_STATUS = {
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  skipped: "SKIPPED",
} as const satisfies Record<Exclude<DispatchReportStatus, "running">, DispatchJobStatus>;

export async function reportDispatchJob(params: {
  jobId: string;
  hostName: string;
  status: DispatchReportStatus;
  message?: string | null;
  tmuxSessionName?: string | null;
  now?: Date;
}): Promise<ReportDispatchJobResult> {
  const now = params.now ?? new Date();
  const job = await db.dispatchJob.findUnique({ where: { id: params.jobId } });
  if (!job) return { ok: false, reason: "not_found" };
  // claimしたホスト以外からの報告は受け付けない。ジョブIDを知っていても、別ホストが
  // 他人のジョブの状態を書き換えられないようにする
  if (job.claimedByHost !== params.hostName) return { ok: false, reason: "wrong_host" };

  const data: Parameters<typeof db.dispatchJob.update>[0]["data"] = {
    message: params.message ?? job.message,
    tmuxSessionName: params.tmuxSessionName ?? job.tmuxSessionName,
  };

  if (params.status === "running") {
    data.status = "RUNNING";
    data.startedAt = job.startedAt ?? now;
    data.heartbeatAt = now;
  } else {
    // `skipped`（#1229）も終了として扱う。**起動しなかっただけで、そのジョブは終わっている。**
    // ここを未完了のままにすると、activeKeyが残って次のジョブを積めなくなる
    data.status = REPORT_STATUS_TO_JOB_STATUS[params.status];
    data.finishedAt = now;
    // 終了したら次のジョブを積めるようにする
    data.activeKey = null;
  }

  // タイムアウトで既に終了扱いになったジョブへ遅れて報告が届くことがある。**上書きしない。**
  // 上書きすると、終了済みのジョブのactiveKeyが復活して次を積めなくなる場合がある
  const result = await db.dispatchJob.updateMany({
    where: { id: job.id, status: { in: ["CLAIMED", "RUNNING"] } },
    data,
  });
  if (result.count === 0) return { ok: false, reason: "already_finished" };

  const updated = await db.dispatchJob.findUnique({ where: { id: job.id } });
  return updated ? { ok: true, job: toJobView(updated) } : { ok: false, reason: "not_found" };
}

export type CancelDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; reason: "not_found" | "not_cancelable"; message?: string };

/**
 * 画面からジョブを取り消す。
 *
 * **取り消せるのは`queued`と`claimed`まで。** `running`はworktreeの作成や依存インストールの
 * 最中で、途中で止めると中途半端なworktreeとブランチが残る（後始末は
 * `scripts/cleanup-worktrees.sh`の仕事になる）。止めたい場合はサブPC側でtmuxセッションを
 * 落とす必要があるため、その旨を理由として返す。
 */
export async function cancelDispatchJob(params: {
  jobId: string;
  now?: Date;
}): Promise<CancelDispatchJobResult> {
  const now = params.now ?? new Date();
  const job = await db.dispatchJob.findUnique({ where: { id: params.jobId } });
  if (!job) return { ok: false, reason: "not_found" };

  if (job.status === "RUNNING") {
    return {
      ok: false,
      reason: "not_cancelable",
      message:
        "起動処理中のジョブは取り消せません。止める場合は起動先で tmux セッションを終了してください。",
    };
  }
  if (job.status !== "QUEUED" && job.status !== "CLAIMED") {
    return { ok: false, reason: "not_cancelable", message: "このジョブは既に終了しています。" };
  }

  const result = await db.dispatchJob.updateMany({
    where: { id: job.id, status: job.status },
    data: {
      status: "CANCELED",
      activeKey: null,
      finishedAt: now,
      message: "画面から取り消されました。",
    },
  });
  if (result.count === 0) {
    return { ok: false, reason: "not_cancelable", message: "このジョブは既に終了しています。" };
  }

  const updated = await db.dispatchJob.findUnique({ where: { id: job.id } });
  return updated ? { ok: true, job: toJobView(updated) } : { ok: false, reason: "not_found" };
}

export type PrioritizeDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; reason: "not_found" | "not_prioritizable"; message?: string };

/** 「先頭へ上げる」を受け付ける種別。セッションを立てるジョブ＝順番の概念があるものだけ */
const PRIORITIZABLE_JOB_KINDS: readonly DispatchJobKind[] = SESSION_LAUNCH_JOB_KINDS;

/**
 * 順番待ちのジョブを先頭へ上げる（#1541）。
 *
 * 夜にまとめて積んだあと「これを次に流したい」が出てくるが、キューは`createdAt`の昇順で
 * 固定されていて、取り消して積み直すと最後尾へ回るだけだった。
 *
 * **任意の並べ替えは持たない。** 主な用途が外出先のスマホで、ドラッグでの並べ替えは操作が
 * 難しいうえ、実際の要求は「これを次に流したい」の1点に尽きる。1ボタンなら押した結果が
 * 「1番になる」で明確になる。
 *
 * **同じホストの`QUEUED`の最大値+1を入れる（単調増加）。** 連打しても順位が入れ替わるだけで、
 * 値が飽和しない範囲で素直に働く。全件を採番し直す形にすると、押すたびに順番待ちの行数ぶんの
 * 更新が走るうえ、その最中に届いたclaimが中途半端な並びを読む。
 *
 * **制御ジョブ（`INTERRUPT`・`KILL`・`INSTRUCTION`）は受け付けない。** あちらは同時実行数の
 * 枠外で起動ジョブより先に配られる（`claimDispatchJob`）ので、順番という概念がそもそも無い。
 */
export async function prioritizeDispatchJob(params: {
  jobId: string;
}): Promise<PrioritizeDispatchJobResult> {
  const job = await db.dispatchJob.findUnique({ where: { id: params.jobId } });
  if (!job) return { ok: false, reason: "not_found" };

  if (job.status !== "QUEUED") {
    return {
      ok: false,
      reason: "not_prioritizable",
      message: "順番待ちのジョブだけを先頭へ上げられます。",
    };
  }
  if (!PRIORITIZABLE_JOB_KINDS.includes(job.kind)) {
    return {
      ok: false,
      reason: "not_prioritizable",
      message: "このジョブには順番がありません（停止・終了・追加指示は先に届きます）。",
    };
  }

  // 同じホストの順番待ちだけを見る。ホストごとに独立したキューなので、他ホストの値に
  // 引きずられて無駄に大きな値が入るのを避ける。
  const top = await db.dispatchJob.findFirst({
    where: {
      targetHost: job.targetHost,
      status: "QUEUED",
      kind: { in: [...PRIORITIZABLE_JOB_KINDS] },
    },
    orderBy: { queuePriority: "desc" },
    select: { queuePriority: true },
  });

  // **`QUEUED`のままであることを条件に更新する。** 押した瞬間にpollerが持っていった場合は
  // 0件で落ち、走り始めたジョブの並びを書き換えずに済む。
  const result = await db.dispatchJob.updateMany({
    where: { id: job.id, status: "QUEUED" },
    data: { queuePriority: (top?.queuePriority ?? 0) + 1 },
  });
  if (result.count === 0) {
    return {
      ok: false,
      reason: "not_prioritizable",
      message: "このジョブは既に実行が始まっています。",
    };
  }

  const updated = await db.dispatchJob.findUnique({ where: { id: job.id } });
  return updated ? { ok: true, job: toJobView(updated) } : { ok: false, reason: "not_found" };
}

export type DismissDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; reason: "not_found" | "not_dismissable"; message?: string };

/**
 * 終了したジョブの表示を画面から消す（#1479）。
 *
 * 終了したジョブは24時間表示され続ける（`FINISHED_JOB_RETENTION_MS`）。実行キューの
 * 「直近の失敗」には取り消しに当たる操作が無く、**原因を把握して対処したあとも丸1日消えない**
 * のがこの関数の理由。
 *
 * **行は消さず`dismissedAt`を入れるだけ。** 失敗理由（`message`）は後から原因を追うときの
 * 唯一の手掛かりで、表示を片付けたいだけの操作で履歴まで失わせない。
 *
 * **未完了のジョブは消せない。** 走っているものを表示だけ消せると、動いている実体が画面の
 * どこにも出ないまま残る。止めたいなら`cancelDispatchJob`の方を使う。
 */
export async function dismissDispatchJob(params: {
  jobId: string;
  now?: Date;
}): Promise<DismissDispatchJobResult> {
  const now = params.now ?? new Date();
  const job = await db.dispatchJob.findUnique({ where: { id: params.jobId } });
  if (!job) return { ok: false, reason: "not_found" };

  if (isActiveDispatchJobStatus(job.status)) {
    return {
      ok: false,
      reason: "not_dismissable",
      message: "まだ終わっていないジョブの表示は消せません。止める場合は取り消してください。",
    };
  }

  // **既に消してあっても成功として返す。** 連打やポーリングの行き違いで2回目が届くのは
  // 想定内で、そこで失敗を出しても押した側にできることが無い
  if (job.dismissedAt === null) {
    await db.dispatchJob.updateMany({
      where: { id: job.id, dismissedAt: null },
      data: { dismissedAt: now },
    });
  }

  const updated = await db.dispatchJob.findUnique({ where: { id: job.id } });
  return updated ? { ok: true, job: toJobView(updated) } : { ok: false, reason: "not_found" };
}

/** 終了したジョブを画面に残す期間。押した結果がすぐ消えると、失敗に気づけない */
const FINISHED_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 引き当てに使うキー。`DispatchJob`側はリポジトリのidを持たないのでfullNameで組む */
function issueTitleKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

/**
 * ジョブ・セッションが指すIssueを、**DBのキャッシュからまとめて引く**（#1519）。
 *
 * 実行キューの行に番号しか出ないと、何のジョブが積まれているのかがGitHubを開くまで分からない。
 * **idも一緒に返す**のは、行のタイトルをissue-deckのIssue詳細への導線にするため（#1625）。
 * 詳細を開く口は`?issue=<id>`でidを取るので、番号だけでは飛べない。
 *
 * **返すidは`Issue.githubIssueId`を文字列にしたもので、DBの行id（cuid）ではない**（#1671）。
 * 画面が持つ`Issue.id`は`dbIssueToDisplayIssue`が`String(row.githubIssueId)`で作っており、
 * `?issue=`・`?missue=`もその識別子で引く。行idを渡すと一覧のどのIssueにも一致せず、
 * PCは詳細ペインが閉じ、スマホはホーム画面へ落ちる（`use-mobile-screen.ts`）。
 *
 * - **ジョブ1件ごとに引かない。** ここは`GET /api/dispatch`＝ポーリング先（未完了ジョブがある間は
 *   5秒間隔）で、最大100件ぶんのクエリを毎回投げるわけにはいかない。リポジトリを1回、
 *   Issueを`(repositoryId, number)`のunique indexで1回の計2本に抑える
 * - **引けなかったものは黙って落とす**（呼び出し側で`null`になる）。同期前のIssueや、
 *   GitHub Appを外したリポジトリのジョブがこれにあたる。タイトルが引けないだけで
 *   キュー全体が見えなくなる方が害が大きい
 */
async function resolveDispatchIssues(
  targets: readonly { repositoryFullName: string; issueNumber: number }[],
): Promise<Map<string, { id: string; title: string }>> {
  const titles = new Map<string, { id: string; title: string }>();
  if (targets.length === 0) return titles;

  const numbersByRepository = new Map<string, Set<number>>();
  for (const target of targets) {
    const numbers = numbersByRepository.get(target.repositoryFullName) ?? new Set<number>();
    numbers.add(target.issueNumber);
    numbersByRepository.set(target.repositoryFullName, numbers);
  }

  // `Repository.fullName`は`@@unique([installationId, fullName])`の一部なので、同じfullNameの行が
  // インストール違いで複数あり得る。**全部を対象にして構わない**（同じIssueなのでタイトルも同じ）。
  // 返すidも`githubIssueId`＝GitHub側の識別子なので、どの行を引き当ててもぶれない（#1671）
  const repositories = await db.repository.findMany({
    where: { fullName: { in: [...numbersByRepository.keys()] } },
    select: { id: true, fullName: true },
  });
  if (repositories.length === 0) return titles;

  const issues = await db.issue.findMany({
    where: {
      OR: repositories.map((repository) => ({
        repositoryId: repository.id,
        number: { in: [...(numbersByRepository.get(repository.fullName) ?? [])] },
      })),
    },
    select: { githubIssueId: true, number: true, title: true, repositoryId: true },
  });

  const fullNameById = new Map(repositories.map((repository) => [repository.id, repository.fullName]));
  for (const issue of issues) {
    const fullName = fullNameById.get(issue.repositoryId);
    if (!fullName) continue;
    // `githubIssueId`はBigIntなので文字列にしてから渡す（そのままではJSONにも載らない）
    titles.set(issueTitleKey(fullName, issue.number), {
      id: String(issue.githubIssueId),
      title: issue.title,
    });
  }
  return titles;
}

/**
 * 画面が必要とするディスパッチの状態一式（#1180の起動先選択・状態表示が使う）。
 * ホストの申告と未完了ジョブ、直近に終わったジョブをまとめて返す。
 */
export async function listDispatchState(now: Date = new Date()): Promise<{
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  sessions: DispatchSessionView[];
  concurrency: number;
}> {
  await expireStaleDispatchJobs(now);

  // セッション（#1217）を専用のエンドポイントではなくここへ足しているのは、画面側が
  // `GET /api/dispatch`と`use-dispatch-state.ts`の1本で状態を読んでいるため。取得口を
  // 増やすと、同じ画面のためにポーリングが2本走ることになる。
  const [hosts, jobs, sessions, concurrency] = await Promise.all([
    db.dispatchHost.findMany({ orderBy: { name: "asc" } }),
    db.dispatchJob.findMany({
      where: {
        // 画面から消した失敗（#1479）は返さない。**未完了のジョブには入らない**ので、
        // ここで落ちるのは終了済みのものだけ（`dismissDispatchJob`）
        dismissedAt: null,
        OR: [
          { status: { in: [...ACTIVE_DISPATCH_JOB_STATUSES] } },
          { finishedAt: { gte: new Date(now.getTime() - FINISHED_JOB_RETENTION_MS) } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    listDispatchSessions(now),
    getDispatchConcurrency(),
  ]);

  // Issueの引き当て（#1519・#1625）は**ジョブとセッションが確定してから**。上の`Promise.all`へ
  // 入れられない（どのIssueを引くかが一覧に依存する）。0件ならクエリも投げない。
  //
  // **ジョブとセッションを1回にまとめる**（#1567）。セッションの行にもタイトルを出すが、
  // 別々に引くと同じリポジトリ・同じIssueを2度読むことになる（同じIssueを指すことが多い）
  const resolvedIssues = await resolveDispatchIssues([...jobs, ...sessions]);

  return {
    hosts: hosts.map((host) => toHostView(host, now)),
    // **`jobs.map(toJobView)`と書かない。** `Array#map`は第2引数にindexを渡すため、
    // それがそのまま引き当て済みのIssueとして渡ってしまう
    jobs: jobs.map((job) =>
      toJobView(
        job,
        resolvedIssues.get(issueTitleKey(job.repositoryFullName, job.issueNumber)) ?? null,
      ),
    ),
    sessions: sessions.map((session) => {
      const issue =
        resolvedIssues.get(issueTitleKey(session.repositoryFullName, session.issueNumber)) ?? null;
      return { ...session, issueTitle: issue?.title ?? null, issueId: issue?.id ?? null };
    }),
    concurrency,
  };
}

/**
 * ホストからの申告を保存する（実行可能リポジトリ＋生存報告）。
 *
 * 申告する内容はサブPC側が`~/.config/issue-deck/local-repos.conf`を走査し、
 * `scripts/start-local-session.sh`と同じ検証を通ったものだけ
 * （`scripts/lib/local-repo-resolve.sh`で共有）。issue-deck側はここで検証をやり直さず、
 * 受け取った一覧をそのまま「割り当ててよい対象」として使う。
 *
 * **`Repository.hasLocalStartScript`（GitHub上のマーカー行）とは無関係**（#1224）。マーカー行を
 * 持たないリポジトリもサブPC側の汎用ランチャーで起動できるため、そちらで絞り込むと
 * 「実際には起動できるのに割り当てられない」ことになる。実際にcloneされ起動できるかを
 * 知っているのは申告する側だけ。
 */
export async function announceDispatchHost(params: {
  hostName: string;
  repositories: unknown;
  contractVersion: number | null;
  maxConcurrency: number | null;
  agentVersion: string | null;
  /** スクリーンショットを撮れるか（#1268）。申告していない古いpollerでは`null` */
  screenshotCapable: boolean | null;
  /** 走っているセッションを操作できるか（#1332）。申告していない古いpollerでは`null`＝非対応 */
  sessionControlCapable: boolean | null;
  /** 追加指示を送れるか（#1012）。申告していないpollerでは`null`＝非対応 */
  instructionCapable: boolean | null;
  /** 横断質問セッションを起こせるか（#1454）。申告していないpollerでは`null`＝非対応 */
  crossRepoQuestionCapable: boolean | null;
  /**
   * セッション本数の上限と、申告した時点で生きていた本数（#1394）。**画面へ出すための写しで、
   * 割り当ての判定には使わない**（判定はpoller側。サブPCのtmuxを見られるのはあちらだけ）。
   * 申告していない古いpollerでは`null`。
   */
  maxSessions: number | null;
  liveSessions: number | null;
  /**
   * 申告した時点のリソース使用率（#1567）。**画面へ出すための写しで、割り当ての判定には
   * 使わない**（`maxSessions`と同じ立場）。申告していない・取得に失敗した巡では`null`で、
   * その場合は7列すべてを`null`へ戻す（前回の値を残すと、古い数字が現在の値として出る）。
   */
  metrics: DispatchHostMetrics | null;
  now?: Date;
}): Promise<DispatchHostView> {
  const now = params.now ?? new Date();
  const repositories = JSON.stringify(normalizeDispatchHostRepositories(params.repositories));
  const values = {
    repositories,
    contractVersion: params.contractVersion,
    maxConcurrency: params.maxConcurrency,
    agentVersion: params.agentVersion,
    screenshotCapable: params.screenshotCapable,
    sessionControlCapable: params.sessionControlCapable,
    instructionCapable: params.instructionCapable,
    crossRepoQuestionCapable: params.crossRepoQuestionCapable,
    maxSessions: params.maxSessions,
    liveSessions: params.liveSessions,
    // 申告が無ければ5列とも`null`へ戻す（#1567）。**前回の値を残さない。**
    // 残すと、metricsを送らなくなったpollerの古い数字が現在の値として出続ける
    cpuPercent: params.metrics?.cpuPercent ?? null,
    memoryUsedMb: params.metrics?.memoryUsedMb ?? null,
    memoryTotalMb: params.metrics?.memoryTotalMb ?? null,
    diskUsedGb: params.metrics?.diskUsedGb ?? null,
    diskTotalGb: params.metrics?.diskTotalGb ?? null,
    // SWAPも同じく毎回上書きする（#1624）。**SWAPを申告しないpollerへ戻ったときにnullへ戻す**
    // 必要があるため、`??`で前回値を残さない
    swapUsedMb: params.metrics?.swapUsedMb ?? null,
    swapTotalMb: params.metrics?.swapTotalMb ?? null,
    lastSeenAt: now,
  };

  const host = await db.dispatchHost.upsert({
    where: { name: params.hostName },
    create: { name: params.hostName, ...values },
    update: values,
  });
  return toHostView(host, now);
}
