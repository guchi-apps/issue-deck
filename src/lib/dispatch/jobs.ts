import { Prisma, type DispatchHost, type DispatchJob } from "@prisma/client";

import {
  DISPATCH_CONCURRENCY_DEFAULT,
  parseClaudeModel,
  type ClaudeModel,
} from "@/lib/app-settings";
import { db } from "@/lib/db";
import {
  buildCodexPairingActiveKey,
  CODEX_PAIRING_ISSUE_NUMBER,
  CODEX_PAIRING_REPOSITORY,
  describeCodexPairingRejection,
  isCodexPairingExpired,
  parseCodexPairingCode,
  resolveCodexPairingRejection,
  type CodexPairingRejection,
} from "@/lib/dispatch/codex-pairing";
import type { DispatchHostCheckout } from "@/lib/dispatch/host-checkout";
import {
  parseDispatchHostLaunchHold,
  type DispatchHostLaunchHold,
  type DispatchHostMetrics,
} from "@/lib/dispatch/host-metrics";
import {
  describeRebootRejection,
  resolveRebootRejection,
  type DispatchHostReboot,
  type RebootRejection,
} from "@/lib/dispatch/host-reboot";
import { listSessionPlanRequests } from "@/lib/dispatch/plan-requests";
import {
  describePreviewRejection,
  resolvePreviewRejection,
  type DispatchHostPreview,
  type PreviewRejection,
} from "@/lib/dispatch/preview-server";
import { listSessionQuestionRequests } from "@/lib/dispatch/question-requests";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import type { SessionQuestionRequestView } from "@/lib/dispatch/session-question-request";
import { listDispatchSessions } from "@/lib/dispatch/sessions";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  buildDispatchActiveKey,
  buildPreviewActiveKey,
  buildRebootActiveKey,
  buildSelfUpdateActiveKey,
  describeDispatchControlTimeout,
  describeDispatchEnqueueRejection,
  describeCodeReviewRejection,
  describeManualStepAbortRejection,
  describeCrossRepoQuestionRejection,
  describeDispatchReportLost,
  describeDispatchTimeout,
  describeManualStepExecutionRejection,
  describePlanReviewRejection,
  describeSessionControlRejection,
  DEFAULT_DISPATCH_AGENT,
  DISPATCH_CLAIM_TIMEOUT_MS,
  DISPATCH_CONTROL_QUEUE_TIMEOUT_MS,
  DISPATCH_HEARTBEAT_TIMEOUT_MS,
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  isActiveDispatchJobStatus,
  isDispatchHostOnline,
  isSessionReportedJobKind,
  normalizeDispatchHostRepositories,
  OUT_OF_BAND_JOB_KINDS,
  parseDispatchHostRepositories,
  parsePreviewAction,
  PREVIEW_ISSUE_NUMBER,
  readDispatchAgent,
  resolveCodeReviewRejection,
  resolveCrossRepoQuestionRejection,
  resolveDispatchConcurrency,
  resolveDispatchAgentRejection,
  resolveManualStepAbortRejection,
  resolveManualStepExecutionRejection,
  resolvePlanReviewRejection,
  resolveSessionControlRejection,
  REBOOT_ISSUE_NUMBER,
  REBOOT_REPOSITORY,
  SELF_UPDATE_ISSUE_NUMBER,
  SELF_UPDATE_REPOSITORY,
  SESSION_CONTROL_JOB_KINDS,
  SESSION_LAUNCH_JOB_KINDS,
  type CodeReviewRejection,
  type CrossRepoQuestionRejection,
  type DispatchAgent,
  type DispatchEnqueueRejection,
  type DispatchHostView,
  type DispatchJobKind,
  type DispatchJobStatus,
  type DispatchJobView,
  type DispatchReportStatus,
  type ManualStepAbortRejection,
  type ManualStepExecutionRejection,
  type PlanReviewRejection,
  type PreviewAction,
  type SessionControlJobKind,
  type SessionControlRejection,
} from "@/lib/dispatch/dispatch-job";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import {
  extractRunnableManualStepCommands,
  fillManualStepPlaceholders,
  findInteractiveCommand,
  findPlaceholder,
  isSubpcManualStepDevice,
  normalizeManualStepPlaceholderValues,
  MANUAL_STEP_TIMEOUT_SECONDS,
} from "@/lib/manual-step-command";
import { parseManualStepGuide, resolveManualStepDevice } from "@/lib/manual-step-guide";

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
  const manualStepValues = parseManualStepPlaceholderValues(job.placeholderValues);
  return {
    id: job.id,
    repositoryFullName: job.repositoryFullName,
    issueNumber: job.issueNumber,
    issueTitle: issue?.title ?? null,
    issueId: issue?.id ?? null,
    targetHost: job.targetHost,
    kind: job.kind,
    // DBの値も信用せず、既知の語だけを通す（#2505。`previewAction`と同じ作法で、列を手で
    // 書き換えられても`ISSUE_DECK_AGENT`へ届く語は変わらない）
    agent: readDispatchAgent(job.agent),
    // DBの値も信用せず、既知の語だけを通す（#2717。未知の語・null はどちらも
    // 「設定の既定に従う」= null になる。`agent`と同じ作法だが、既定へ落とすのではなく
    // **落とし先が「指定なし」**である点だけが違う）
    claudeModel: parseClaudeModel(job.claudeModel),
    status: job.status,
    message: job.message,
    instruction: job.instruction,
    command: job.command,
    placeholderValues: manualStepValues,
    // **サーバー側で差し込んだ結果も渡す**（#2403）。pollerは自分でも差し込み直し、
    // ここと一致しなければ実行しない（照合を2回行うのと同じ形の2枚目の壁）
    resolvedCommand:
      job.command === null || manualStepValues === null
        ? job.command
        : fillManualStepPlaceholders(job.command, manualStepValues),
    manualStepLine: job.manualStepLine,
    targetJobId: job.targetJobId,
    // DBの値も信用せず、既知の3語だけを通す（#2444。列を手で書き換えられても、
    // pollerへ届く操作の種類は変わらない）
    previewAction: parsePreviewAction(job.previewAction),
    exitCode: job.exitCode,
    commandOutput: job.commandOutput,
    // 発行したペアリングコード（#2524）。**期限を過ぎたら返さない。**
    // 列そのものは`expireStaleDispatchJobs`が空にするが、掃くのは次の巡（最大30秒後）なので、
    // 読む側でも切る——切れたコードを画面へ出すと、押した人は効かないコードを打ち込むことになる
    codexPairingCode: isCodexPairingExpired(job.codexPairingExpiresAt)
      ? null
      : parseCodexPairingCode(job.codexPairingCode),
    codexPairingExpiresAt: isCodexPairingExpired(job.codexPairingExpiresAt)
      ? null
      : (job.codexPairingExpiresAt?.toISOString() ?? null),
    tmuxSessionName: job.tmuxSessionName,
    queuePriority: job.queuePriority,
    createdAt: job.createdAt.toISOString(),
    claimedAt: job.claimedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * `DispatchJob.placeholderValues`（JSON列）を、差し込みに使える形だけに絞って読む（#2403）。
 *
 * **DBに入っている値も信用しない。** 保存時にも`normalizeManualStepPlaceholderValues`を
 * 通しているが、読む側で絞り直しておけば、列を手で書き換えられても差し込める形は変わらない。
 */
function parseManualStepPlaceholderValues(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeManualStepPlaceholderValues(value as Record<string, unknown>);
}

/** ISO文字列をそのままDBの日時列へ入れるための変換。渡されなければ`null`（列も`null`へ戻す） */
function toDate(iso: string | null | undefined): Date | null {
  return iso ? new Date(iso) : null;
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
    manualStepCapable: host.manualStepCapable,
    manualStepAbortCapable: host.manualStepAbortCapable,
    manualStepValuesCapable: host.manualStepValuesCapable,
    planReviewCapable: host.planReviewCapable,
    codeReviewCapable: host.codeReviewCapable,
    codexCapable: host.codexCapable,
    codexRemoteControlCapable: host.codexRemoteControlCapable,
    selfUpdateCapable: host.selfUpdateCapable,
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
    // 起動の見送り（#2095）。**3列が揃っているときだけ見送り扱いにする**（使用率の5列と同じ向き。
    // 1つでも`null`なら`parseDispatchHostLaunchHold`が全体を落とす）。理由だけが残った状態を
    // 「0%で見送っている」と読ませない
    launchHold: parseDispatchHostLaunchHold({
      reason: host.launchHoldReason,
      percent: host.launchHoldPercent,
      thresholdPercent: host.launchHoldThresholdPercent,
    }),
    // チェックアウトの版（#1612）。**`commit`が無ければ申告そのものが無かった扱い**で、
    // 残りの4列は「取れなかった項目」として個別にnullになりうる（`parseDispatchHostCheckout`
    // と同じ向き。使用率の5列のように「まとめて入るかまとめてnullか」にはしない）
    checkout:
      host.checkoutCommit === null
        ? null
        : {
            commit: host.checkoutCommit,
            branch: host.checkoutBranch,
            committedAt: host.checkoutCommittedAt?.toISOString() ?? null,
            behindCount: host.checkoutBehind,
            fetchedAt: host.checkoutFetchedAt?.toISOString() ?? null,
          },
    previewCapable: host.previewCapable,
    rebootCapable: host.rebootCapable,
    // 再起動まわりの申告（#2496）。**`rebootRequired`が無ければ申告そのものが無かった扱い**で、
    // 残りの2列は「取れなかった項目」として個別にnullになりうる（チェックアウトと同じ向き）
    reboot:
      host.rebootRequired === null
        ? null
        : {
            required: host.rebootRequired,
            requiredSince: host.rebootRequiredSince?.toISOString() ?? null,
            bootedAt: host.bootedAt?.toISOString() ?? null,
          },
    // **申告が無ければ`null`**（絞り込めない）。空配列へ倒すと、対応していないpollerのホストで
    // 一覧が丸ごと消える。壊れたJSONも同じ扱いにする（`parseDispatchHostRepositories`は
    // 壊れていれば空配列を返すため、そこでは区別が付かない）
    previewRepositories:
      host.previewRepositories === null
        ? null
        : parseDispatchHostRepositories(host.previewRepositories),
    // 動いている確認環境（#2444）。**`repository`と`port`が揃っているときだけ動いている扱い**で、
    // 残りは「取れなかった項目」として個別にnullになりうる（チェックアウトの版と同じ向き）。
    // `tailscale serve`が使えないホストにURLは無く、`--no-update`で起こせばブランチが無い
    preview:
      host.previewRepository === null || host.previewPort === null
        ? null
        : {
            repository: host.previewRepository,
            port: host.previewPort,
            branch: host.previewBranch,
            url: host.previewUrl,
            commit: host.previewCommit,
            subject: host.previewSubject,
            startedAt: host.previewStartedAt?.toISOString() ?? null,
            idleMinutes: host.previewIdleMinutes,
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
        // 危険になる**（何時間も後に届いた`C-c`は、そのとき走っている別の作業を止める）。
        // **手作業の代行実行（#1828）も同じ扱い**——承認した時点のホストの状態に対する実行で、
        // 何時間も後に届いてよいものではない
        {
          status: "QUEUED",
          kind: { in: [...SESSION_CONTROL_JOB_KINDS, ...OUT_OF_BAND_JOB_KINDS] },
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
            // **終わったら埋めた値を捨てる**（#2403。報告で終わる経路と同じ）
            placeholderValues: Prisma.DbNull,
          }
        : {
            status: "TIMEOUT",
            activeKey: null,
            finishedAt: now,
            message:
              job.status === "QUEUED"
                ? describeDispatchControlTimeout()
                : describeDispatchTimeout(job.status),
            placeholderValues: Prisma.DbNull,
          },
    });
    expired += result.count;
  }

  // **期限の切れたペアリングコードを列ごと空にする**（#2524）。ジョブの状態とは無関係に、
  // 値そのものに10分の寿命がある。読む側（`toJobView`）でも切っているが、そちらは画面に
  // 出さないだけで、行にはコードが残る——**資格情報を持ち続ける理由が無い**ので消す
  // （`placeholderValues`を終了時に捨てるのと同じ立場）。
  await db.dispatchJob.updateMany({
    where: { codexPairingExpiresAt: { lt: now } },
    data: { codexPairingCode: null, codexPairingExpiresAt: null },
  });

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
  // 制御ジョブ（枠外で走り、tmuxを1回叩いて終わる）はセッションを立てないので対象外。
  //
  // **計画レビュー（#1855）・コードレビュー（#698）も外す。** セッションは立てるが、名前が
  // `-issue-`の規約から外れているためpollerは報告せず、`DispatchSession`の行にならない。
  // ここで拾おうとすると、代わりに**同じIssueの実装セッション**（計画の承認待ちなどで
  // 生きている）に一致し、届かなかったレビューを「そのセッションで起動できていた」ことに
  // してしまう。判定は`SESSION_REPORTED_JOB_KINDS`を正とする（#2443）。
  const launchJobs = stale.filter(
    (job) =>
      isSessionReportedJobKind(job.kind) && (job.status === "CLAIMED" || job.status === "RUNNING"),
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
  /**
   * 起こすエージェントCLI（#2505）。省略すると既定（`claude`）＝従来どおりの挙動。
   *
   * **既定以外を指定できるのは、対応を申告しているホストだけ**（`agent_not_capable`）。
   * 古いpollerはジョブの`agent`を読まないため、配るとCodexを選んだのにClaude Codeが
   * 黙って立つ。画面側でも選択欄を出さないが、**判定はここにも置く**（一括投入のように
   * 画面の判定を通らない経路があるため。`session_alive`と同じ理由）。
   */
  agent?: DispatchAgent;
  /**
   * このIssueだけに使うClaudeのモデル（#2717）。**省略・`null`は「設定の既定に従う」**で、
   * 従来どおりの挙動になる。
   *
   * **ホストの申告では塞がない**（`agent`と違う点）。`--model`はどのバージョンのClaude Codeでも
   * 受け付ける引数で、古いpollerに当たった場合はジョブの値が読まれず設定の既定で立つだけ
   * ——選んだのに別のCLIが立つ`agent`と違い、黙って壊れる方向が無い。
   */
  claudeModel?: ClaudeModel | null;
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

  // 既定以外のエージェント（#2505）は、対応を申告しているホストにしか配らない。
  // **理由の文言は画面と同じ関数から取る**（`resolveDispatchAgentRejection`）。ここは
  // ホストの行を持っているので`toHostView`を通さず、判定に要る2つだけを渡す
  const agent = params.agent ?? DEFAULT_DISPATCH_AGENT;
  const agentRejection = resolveDispatchAgentRejection(
    { name: host.name, codexCapable: host.codexCapable } as DispatchHostView,
    agent,
  );
  if (agentRejection) {
    return { ok: false, rejection: "agent_not_capable", message: agentRejection };
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
        agent,
        // 「設定に従う」はnullで持つ（#2717）。エイリアスの実体を書き込むと、
        // 後で設定を変えても積み置きのジョブだけ古い既定のまま立つ
        claudeModel: params.claudeModel ?? null,
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

export type EnqueuePlanReviewJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: PlanReviewRejection; message: string };

/**
 * 計画の関門（G1・#1218）のセッションを積む（#1855）。
 *
 * 呼ぶのは2か所。**計画コメントの投稿（`postSessionPlan`）からの自動起動**と、画面の
 * 「計画をレビュー」ボタン。どちらも同じ判定を通す。
 *
 * **起動ジョブ（`enqueueDispatchJob`）と決定的に違うのは、動いているセッションで弾かないこと。**
 * 計画を出したセッションは承認待ちで生きているのが常態で、そこで弾くと自動起動が常に断られる
 * （この機能そのものが成立しない）。二重起動は`activeKey`（`plan_review:owner/repo#番号`）が
 * 止めるので、同じIssueに未処理の計画レビューは1件までになる。
 */
export async function enqueuePlanReviewJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueuePlanReviewJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const reject = (rejection: PlanReviewRejection): EnqueuePlanReviewJobResult => ({
    ok: false,
    rejection,
    message: describePlanReviewRejection(rejection, {
      hostName: params.hostName,
      repositoryFullName: params.repositoryFullName,
    }),
  });

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });

  // 判定そのものは画面側と同じ関数を使う（片方だけで持つと、押せるのに拒否される状態が生まれる）
  const rejection = resolvePlanReviewRejection({
    host: host
      ? {
          online: isDispatchHostOnline(host.lastSeenAt, now),
          planReviewCapable: host.planReviewCapable,
          repositories: parseDispatchHostRepositories(host.repositories),
        }
      : null,
    repositoryFullName: params.repositoryFullName,
    // 二重投入はactiveKeyのunique制約が確実に止める（下のcatch）。ここでは先読みしない
    hasActiveJob: false,
  });
  if (rejection) return reject(rejection);

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        kind: "PLAN_REVIEW",
        status: "QUEUED",
        activeKey: buildDispatchActiveKey(
          params.repositoryFullName,
          params.issueNumber,
          "PLAN_REVIEW",
        ),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    return reject("already_queued");
  }
}

export type EnqueueCodeReviewJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: CodeReviewRejection; message: string };

/**
 * リポジトリ全体のコードレビュー（#698）のセッションを積む。
 *
 * 呼ぶのは画面の「コードレビューを実行」だけ（自動で積む経路は無い）。**対象リポジトリが
 * そのホストにcloneされていることを見る**のは計画レビューと同じで、読むコードがそこにしか無いため。
 *
 * 二重投入は`activeKey`（`code_review:owner/repo#番号`）が止める。レビューは実行のたびに
 * 新しいIssueを作るので、実際にはここで衝突するのは同じレビューIssueへの押し直しだけ。
 */
export async function enqueueCodeReviewJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueCodeReviewJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const reject = (rejection: CodeReviewRejection): EnqueueCodeReviewJobResult => ({
    ok: false,
    rejection,
    message: describeCodeReviewRejection(rejection, {
      hostName: params.hostName,
      repositoryFullName: params.repositoryFullName,
    }),
  });

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });

  // 判定そのものは画面側と同じ関数を使う（片方だけで持つと、押せるのに拒否される状態が生まれる）
  const rejection = resolveCodeReviewRejection({
    host: host
      ? {
          online: isDispatchHostOnline(host.lastSeenAt, now),
          codeReviewCapable: host.codeReviewCapable,
          repositories: parseDispatchHostRepositories(host.repositories),
        }
      : null,
    repositoryFullName: params.repositoryFullName,
    // 二重投入はactiveKeyのunique制約が確実に止める（下のcatch）。ここでは先読みしない
    hasActiveJob: false,
  });
  if (rejection) return reject(rejection);

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        kind: "CODE_REVIEW",
        status: "QUEUED",
        activeKey: buildDispatchActiveKey(
          params.repositoryFullName,
          params.issueNumber,
          "CODE_REVIEW",
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

export type EnqueueManualStepJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: ManualStepExecutionRejection; message: string };

/**
 * 手作業アシスタントの手順を、サブPCで代行実行するジョブを積む（#1828）。
 *
 * **画面から届いた文字列を実行しない。** 受け取るのは「どのIssueのどの手順か」（`stepLine`）と
 * 「人が承認したコマンド」（`approvedCommand`）で、実際にジョブへ載せるのは**この関数が
 * Issue本文から抽出し直したもの**。承認した文字列は「人が見て押したのはこれか」の照合にしか
 * 使わない。ここが、この機能を「画面から任意のコマンドを流せる口」にしないための一次の歯止め
 * （二次の歯止めはサブPC側で、pollerがGitHubの本文を読み直して同じ照合をもう一度行う）。
 *
 * 本文はDBのIssueキャッシュから読む。**画面が見ているのと同じ本文**で、人が承認したのは
 * その表示なので、照合の相手としてはGitHubの最新よりこちらが正しい（GitHub側との突き合わせは
 * pollerが実行の直前に行う）。
 */
export async function enqueueManualStepJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  /** 実行する手順の`- [ ]`の行番号 */
  stepLine: number;
  /** 画面に出ていて、人が承認したコマンド。**照合専用** */
  approvedCommand: string;
  /**
   * 人が埋めたプレースホルダの値（#2403。`<控えたkey>`の表記 → 値）。
   *
   * **受け取るのは値だけで、コマンドの文字列は受け取らない。** 形は`approvedCommand`と同じく
   * 本文から取り直したものを使い、値はその穴へ引用付きで差し込む。したがって画面から届いた
   * 値は**リテラルの1語**にしかならず、コマンドの構造を変えられない。
   */
  placeholderValues?: Record<string, string> | null;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueManualStepJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const reject = (
    rejection: ManualStepExecutionRejection,
    context: {
      interactiveCommand?: string | null;
      placeholder?: string | null;
      /** 拒否の対象になった項目のデバイス（#2052。理由文に出す） */
      device?: string | null;
    } = {},
  ): EnqueueManualStepJobResult => ({
    ok: false,
    rejection,
    message: describeManualStepExecutionRejection(rejection, {
      hostName: params.hostName,
      ...context,
    }),
  });

  const issue = await findIssueForManualStep(params.repositoryFullName, params.issueNumber);
  // Issueを引けない＝同期前・GitHub Appを外したリポジトリ。**本文が読めないなら代行しない**
  if (!issue) return reject("not_manual_step");
  if (!issue.labels.some((label) => label.name === MANUAL_STEP_LABEL)) {
    return reject("not_manual_step");
  }

  const guide = parseManualStepGuide(issue.body);
  // **デバイスは手順ごとに見る**（#2052）。`stepLine`が手順を指していればその手順のデバイス、
  // 完了の確認（節に手順が無い）なら手作業の既定値。判定の順は画面
  // （`resolveManualStepExecutionRejection`）と同じで、コマンドの有無より先に見る
  const targetStep = guide.steps.find((step) => step.line === params.stepLine) ?? null;
  const device = resolveManualStepDevice(guide.where, targetStep);
  if (!isSubpcManualStepDevice(device)) return reject("device_not_subpc", { device });

  // 手順（`## やること`）と完了の確認（`## 完了の確認方法`）の両方が対象（#1869）。
  // **画面と同じ関数で取り出す**ので、押せるのにAPIが拒否する組み合わせが生まれない
  const extracted = extractRunnableManualStepCommands(issue.body, guide).find(
    (entry) => entry.stepLine === params.stepLine,
  );
  if (!extracted) return reject("no_command");
  // **一致しなければ実行しない。** 承認した後に本文が書き換わった場合で、押した人が見たものと
  // これから実行するものが違う（画面を更新して、変わった内容を見てから押し直してもらう）
  if (extracted.command !== params.approvedCommand) return reject("body_changed");

  // **対話が要るコマンドは積まない**（#2025）。積んでも代行実行のシェルには標準入力が無く、
  // 失敗か打ち切りで終わる。画面（`buildManualStepRunPlan`）と同じ関数で判定するので、
  // 押せるのにここで拒否される組み合わせは生まれない
  const interactiveCommand = findInteractiveCommand(extracted.command);
  // **人が埋めた値を先に差し込んでから、穴の有無を見る**（#2403）。差し込むのは名前の付く
  // `<…>`だけで、値はシェルの引用で包まれる（`fillManualStepPlaceholders`）。
  //
  // **判定に使うのは差し込んだ後の文字列で、「埋めた個数」では判定しない**（#2403の計画
  // レビューG1・指摘1）。`findPlaceholder`が見るのは4種（`<…>`・`***`・`…`・`xxx`）で、
  // 山括弧だけを数えて「全部埋まった」と見なすと、残り3種の穴が空いたまま素通りする。
  const received = normalizeManualStepPlaceholderValues(params.placeholderValues);
  const filledCommand =
    received === null
      ? extracted.command
      : fillManualStepPlaceholders(extracted.command, received);
  // **差し込みが実際に起きたときだけ「値付きの実行」として扱う。** 画面は開いているIssueぶんの
  // 値をまとめて持っているので、この手順に合う穴が無ければ何も変わらない。その場合まで
  // pollerの申告を要求すると、値と無関係な手順まで押せなくなる（修正案の適用後の実行など）
  const placeholderValues = filledCommand === extracted.command ? null : received;
  // **穴が空いたコマンドは積まない**（#2051）。値が埋まっていないコマンドは失敗するだけでなく、
  // `KEY=<値>`のようにシェルのリダイレクトとして解釈されて意図しない失敗の仕方をする
  const placeholder = findPlaceholder(filledCommand);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const rejection = resolveManualStepExecutionRejection({
    host: host
      ? {
          online: isDispatchHostOnline(host.lastSeenAt, now),
          manualStepCapable: host.manualStepCapable,
          manualStepValuesCapable: host.manualStepValuesCapable,
        }
      : null,
    isManualStepIssue: true,
    isSubpcDevice: true,
    hasCommand: true,
    interactiveCommand,
    placeholder,
    // 値を差し込む実行は、pollerの申告が真のホストにしか配らない（#2403）。古いpollerは
    // `placeholderValues`を黙って無視し、穴が空いたままの`command`を実行してしまう
    usesPlaceholderValues: placeholderValues !== null,
    // 二重投入はactiveKeyのunique制約が止める（下のcatch）。ここでは先読みしない
    hasActiveJob: false,
  });
  if (rejection) return reject(rejection, { interactiveCommand, placeholder });

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        kind: "MANUAL_STEP",
        status: "QUEUED",
        // **Issue単位で1件まで**（手順単位にしない）。同じ手作業の2つの手順が同時に走ると、
        // 順番に実行する前提の手順（`git pull`→`systemctl restart`）が入れ替わりうる
        activeKey: buildDispatchActiveKey(
          params.repositoryFullName,
          params.issueNumber,
          "MANUAL_STEP",
        ),
        requestedByUserId: params.requestedByUserId,
        // **保存するのはテンプレート（`<…>`が入ったまま）**。本文との照合はサーバーとpollerが
        // これで2回行い、値を差し込むのは照合を通したあと（#2403）
        command: extracted.command,
        placeholderValues: placeholderValues ?? undefined,
        manualStepLine: params.stepLine,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    return reject("already_queued");
  }
}

export type EnqueueManualStepAbortJobResult =
  | { ok: true; job: DispatchJobView }
  | {
      ok: false;
      rejection: ManualStepAbortRejection | "already_queued" | "not_running";
      message: string;
    };

/**
 * 走っている代行実行を止めるジョブを積む（#1882）。
 *
 * **止める対象はジョブのidで指し、コマンドは渡さない。** pollerが
 * `issue-deck-manual-step-<id>`というユニット名を組み立て直して止めるので、ここが
 * 任意の`systemctl stop`を流す口にはならない（`INTERRUPT`・`KILL`がセッション名を
 * 組み立て直すのと同じ作法）。
 *
 * **止められるのは走り出した後（`RUNNING`）だけ。** まだ払い出していないジョブは
 * 取り消し（`cancelDispatchJob`）の担当で、そちらの方が確実に止まる。
 */
export async function enqueueManualStepAbortJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  /** 止める対象の`MANUAL_STEP`ジョブのid */
  targetJobId: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueManualStepAbortJobResult> {
  const now = params.now ?? new Date();

  const target = await db.dispatchJob.findUnique({ where: { id: params.targetJobId } });
  if (!target || target.kind !== "MANUAL_STEP" || target.status !== "RUNNING") {
    return {
      ok: false,
      rejection: "not_running",
      message: "走っている代行実行が見つかりませんでした（既に終わっている可能性があります）。",
    };
  }

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const rejection = resolveManualStepAbortRejection(
    host
      ? {
          online: isDispatchHostOnline(host.lastSeenAt, now),
          manualStepAbortCapable: host.manualStepAbortCapable,
        }
      : null,
  );
  if (rejection !== null) {
    return {
      ok: false,
      rejection,
      message: describeManualStepAbortRejection(rejection, {
        hostName: params.hostName,
        timeoutMinutes: MANUAL_STEP_TIMEOUT_SECONDS / 60,
      }),
    };
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        kind: "MANUAL_STEP_ABORT",
        status: "QUEUED",
        // 種別ごとに名前空間を分ける（#1332と同じ）。**未処理の中断は1件まで**で、
        // 連打しても同じ停止が積み上がらない
        activeKey: buildDispatchActiveKey(
          params.repositoryFullName,
          params.issueNumber,
          "MANUAL_STEP_ABORT",
        ),
        requestedByUserId: params.requestedByUserId,
        targetJobId: params.targetJobId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    return {
      ok: false,
      rejection: "already_queued",
      message: "この手作業には未処理の中断があります（届くまで最大30秒かかります）。",
    };
  }
}

export type SelfUpdateRejection = "host_not_found" | "not_capable" | "already_queued";

export type EnqueueSelfUpdateJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: SelfUpdateRejection; message: string };

/**
 * サブPCのチェックアウトを最新へ追随させ、pollerを再起動する（#1875）。
 *
 * **pollerは自分から`git pull`しない**——レビューを経ていないコードが無人で走り出す形にせず、
 * 取り込むかどうかは人が決める、という設計のため（`scripts/subpc-dispatch-poller.sh`）。
 * この経路は**人が画面で押したときだけ**動くので、その設計を崩さずに、`ssh`して
 * `git pull && systemctl restart`する手作業（#1858・#1867）をなくせる。
 *
 * **遅れが無くても弾かない。** pollerは`--ff-only`で引くため、既に最新なら何も起きずに
 * 再起動だけが走る。押せるかどうかの判断は画面側に任せ、ここでは受け付ける。
 */
export async function enqueueSelfUpdateJob(params: {
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueSelfUpdateJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  if (!host) {
    return {
      ok: false,
      rejection: "host_not_found",
      message: `${params.hostName} はまだ申告していません。pollerが動いているか確認してください。`,
    };
  }
  // **申告していないpollerへ配らない。** 未知の種別として`failed`で返ってくるだけで、
  // 押した更新が失われる（`claimDispatchJobs`の分岐と対になっている）
  if (host.selfUpdateCapable !== true) {
    return {
      ok: false,
      rejection: "not_capable",
      message: `${params.hostName} のpollerはチェックアウトの更新に対応していません。先に手元で更新してください。`,
    };
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: SELF_UPDATE_REPOSITORY,
        issueNumber: SELF_UPDATE_ISSUE_NUMBER,
        targetHost: params.hostName,
        kind: "SELF_UPDATE",
        status: "QUEUED",
        activeKey: buildSelfUpdateActiveKey(params.hostName),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    // activeKeyのunique制約。二重クリックや、前の更新がまだ終わっていない場合
    return {
      ok: false,
      rejection: "already_queued",
      message: `${params.hostName} の更新は既に積まれています。`,
    };
  }
}

export type EnqueueRebootJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: RebootRejection; message: string };

/**
 * ホストごと再起動する（#2496）。
 *
 * **`SELF_UPDATE`（#1875）とは別のジョブにしてある。** あちらが畳むのはpollerのプロセスだけで、
 * `exec`で入れ替わるため走っている実装セッションは残る（#1927）。こちらはOSごと落ちるので、
 * tmuxのセッションは全部消えて会話も戻らない。同じ経路に相乗りさせると、pollerが
 * 「更新のつもりで再起動する」ことになる。
 *
 * **判定は`resolveRebootRejection`に寄せて、画面と同じ関数を使う**（`enqueuePreviewJob`と同じ形）。
 * 画面が押せると判断した操作だけが届く前提にはせず、ここでもやり直す。
 *
 * **ただし最後の砦はpoller側。** ここが見ているセッション本数は最大30秒古い申告で、押してから
 * 届くまでの間に新しいセッションが立ちうる。pollerは受け取った時点で`tmux ls`を数え直し、
 * 0本でなければ実行せずに失敗として返す（同じ判定を独立に2回行う、`MANUAL_STEP`と同じ作法）。
 */
export async function enqueueRebootJob(params: {
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueRebootJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const rejection = resolveRebootRejection({
    host: host ? toHostView(host, now) : null,
    // 未処理があるかはactiveKeyのunique制約が最終的に弾くので、ここでは見ない
    // （見るなら追加のクエリが要るうえ、競合はどのみち制約でしか閉じられない）
    hasQueuedJob: false,
  });
  if (rejection) {
    return { ok: false, rejection, message: describeRebootRejection(rejection, params.hostName) };
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: REBOOT_REPOSITORY,
        issueNumber: REBOOT_ISSUE_NUMBER,
        targetHost: params.hostName,
        kind: "REBOOT",
        status: "QUEUED",
        activeKey: buildRebootActiveKey(params.hostName),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    // activeKeyのunique制約。二重クリックや、前の再起動がまだ終わっていない場合
    return {
      ok: false,
      rejection: "already_queued",
      message: describeRebootRejection("already_queued", params.hostName),
    };
  }
}

export type EnqueueCodexPairingJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: CodexPairingRejection; message: string };

/**
 * CodexのRemote Control相当（#2524）。ペアリングコードを1枚発行する。
 *
 * **判定は`resolveCodexPairingRejection`に寄せて、画面と同じ関数を使う**（`enqueueRebootJob`と
 * 同じ形）。画面が押せると判断した操作だけが届く前提にはしない。
 *
 * **未処理は1件まで（ホスト単位）。** 連打しても増えるのは短命のコードだけで、押した人が
 * 見るのは最後の1枚になる（`buildCodexPairingActiveKey`）。
 */
export async function enqueueCodexPairingJob(params: {
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueCodexPairingJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const rejection = resolveCodexPairingRejection({
    host: host ? toHostView(host, now) : null,
    // 未処理があるかはactiveKeyのunique制約が最終的に弾く（`enqueueRebootJob`と同じ）
    hasQueuedJob: false,
  });
  if (rejection) {
    return {
      ok: false,
      rejection,
      message: describeCodexPairingRejection(rejection, params.hostName),
    };
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: CODEX_PAIRING_REPOSITORY,
        issueNumber: CODEX_PAIRING_ISSUE_NUMBER,
        targetHost: params.hostName,
        kind: "CODEX_PAIRING",
        status: "QUEUED",
        activeKey: buildCodexPairingActiveKey(params.hostName),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    return {
      ok: false,
      rejection: "already_queued",
      message: describeCodexPairingRejection("already_queued", params.hostName),
    };
  }
}

export type EnqueuePreviewJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: PreviewRejection; message: string };

/**
 * 確認環境（#2444）を起こす・最新へ入れ替える・止める。
 *
 * **判定は`resolvePreviewRejection`に寄せて、画面と同じ関数を使う**（`resolveManualStepExecutionRejection`
 * と同じ形）。画面が押せると判断した操作だけが届く前提にはせず、ここでも同じ判定をやり直す。
 *
 * **未処理は1件まで（ホスト単位）。** 同時に動かせる確認環境は1つなので、「issue-deckを起こす」と
 * 「dayspanを起こす」が同時に積まれると、後から届いた方が前を止めて上書きする。押した人から
 * 見れば「押したのに別のものが立った」ようにしか見えない（`buildPreviewActiveKey`）。
 */
export async function enqueuePreviewJob(params: {
  hostName: string;
  repositoryFullName: string;
  action: PreviewAction;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueuePreviewJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const rejection = resolvePreviewRejection({
    host: host ? toHostView(host, now) : null,
    repositoryFullName: params.repositoryFullName,
    action: params.action,
    // 未処理があるかはactiveKeyのunique制約が最終的に弾くので、ここでは見ない
    // （見るなら追加のクエリが要るうえ、競合はどのみち制約でしか閉じられない）
    hasQueuedJob: false,
  });
  if (rejection) {
    return { ok: false, rejection, message: describePreviewRejection(rejection) };
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: PREVIEW_ISSUE_NUMBER,
        targetHost: params.hostName,
        kind: "PREVIEW",
        status: "QUEUED",
        activeKey: buildPreviewActiveKey(params.hostName),
        previewAction: params.action,
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    // activeKeyのunique制約。二重クリックや、前の操作がまだ終わっていない場合
    return {
      ok: false,
      rejection: "already_queued",
      message: describePreviewRejection("already_queued"),
    };
  }
}

/** 代行実行の判定に要る本文とラベルを、DBのIssueキャッシュから引く（#1828） */
async function findIssueForManualStep(
  repositoryFullName: string,
  issueNumber: number,
): Promise<{ body: string | null; labels: { name: string }[] } | null> {
  // `Repository.fullName`はインストール違いで複数行あり得るので`findFirst`で受ける
  // （同じIssueなので本文もラベルも同じ。`resolveDispatchIssues`と同じ扱い）
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    select: { id: true },
  });
  if (!repository) return null;

  return db.issue.findFirst({
    where: { repositoryId: repository.id, number: issueNumber },
    select: { body: true, labels: { select: { name: true } } },
  });
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
  // **手作業の代行実行（#1828）も枠外で先に配る。** セッションを立てないので枠を消費せず、
  // 承認から5分で失効する以上、起動待ちの後ろに並ばせると届く前に失効しうる。
  // 対応を申告していないpollerには配らない（未知の種別として`failed`になり、押した実行が失われる）
  // **枠外のジョブでも申告は種別ごとに見る。** 手作業の代行に対応した既存のpollerは
  // チェックアウトの更新（#1875）を知らないため、`OUT_OF_BAND_JOB_KINDS`をまとめて配ると
  // 未知の種別として`failed`になり、押した更新が失われる。
  if (host?.manualStepCapable === true) controlKinds.push("MANUAL_STEP");
  // **中断（#1882）は代行実行とは別の申告で配る。** 代行実行を実行できるpollerでも、止める側の
  // 実装が入っているとは限らない。非対応のpollerへ配ると未知の種別として`failed`になり、
  // 画面には「中断できなかった」だけが残る（そのときは打ち切りを待つ案内を出す方が正しい）
  if (host?.manualStepAbortCapable === true) controlKinds.push("MANUAL_STEP_ABORT");
  if (host?.selfUpdateCapable === true) controlKinds.push("SELF_UPDATE");
  // 確認環境（#2444）も枠外。セッションを立てないので枠を消費しない。**申告していないpollerへは
  // 配らない**（未知の種別として`failed`になり、押した操作が失われる）
  if (host?.previewCapable === true) controlKinds.push("PREVIEW");
  // ホストの再起動（#2496）も枠外。セッションを立てない点は確認環境と同じで、**申告していない
  // pollerへは配らない**（未知の種別として`failed`になり、押した再起動が失われる）
  if (host?.rebootCapable === true) controlKinds.push("REBOOT");
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
  // **計画レビュー（G1・#1855）も同じ枠。** tmuxセッションを立てる点は横断質問と同じで、
  // 対応を申告していないpollerに配ると、計画を出すたびに`failed`のジョブが並ぶ
  if (host?.planReviewCapable === true) launchKinds.push("PLAN_REVIEW");
  // **コードレビュー（#698）も同じ枠。** レビュー1本で終わるが、走っている間はtmuxセッションを
  // 1本占めるため、枠外へ出すと本数の見積もりが崩れる（計画レビューと同じ扱い）
  if (host?.codeReviewCapable === true) launchKinds.push("CODE_REVIEW");

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

  // **再起動が積まれている間は起動ジョブを配らない**（#2496）。落とす前に入口を閉じないと、
  // 押してから届くまでの数十秒に新しいセッションが立ち、pollerの側の「0本か」の確かめ直しに
  // 引っかかって再起動そのものが失敗する（押した人からは「押したのに落ちない」に見える）。
  //
  // **止めるのは起動ジョブだけで、制御ジョブは上で既に配ってある。** 走っているセッションを
  // 止める`C-c`や畳む操作は、むしろ再起動へ近づける操作なので塞ぐ理由が無い。
  //
  // 再起動が済んだ後は、pull型なのでホストが落ちている間に配られることは無い（誰も取りに
  // 来ないだけ）。溜まった起動ジョブは戻ってきた最初の巡から順に流れる。
  const pendingReboot = await db.dispatchJob.count({
    where: {
      targetHost: params.hostName,
      kind: "REBOOT",
      status: { in: ["QUEUED", "CLAIMED", "RUNNING"] },
    },
  });
  if (pendingReboot > 0) return claimed;

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
  /** 代行実行（#1828）の終了コード。`0`のときだけ画面が手順のチェックを付ける */
  exitCode?: number | null;
  /** 代行実行の出力。**受け口で長さを切ってから渡す**（`MANUAL_STEP_OUTPUT_MAX_LENGTH`） */
  output?: string | null;
  /**
   * 発行したCodexのペアリングコード（#2524）と、その期限。
   *
   * **受け口で形（`XXXX-XXXX`）と期限の範囲を通してから渡す**（`output`と同じ立場）。
   * 期限が読めなければコードごと捨てる——切れているかどうかを判定できない資格情報は残さない。
   */
  codexPairingCode?: string | null;
  codexPairingExpiresAt?: Date | null;
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
    // 代行実行の結果（#1828）。**送られてこなければ触らない**（`running`の報告で終了コードを
    // nullへ戻さないため）。実行したのがコマンドではないジョブには最初から入らない
    exitCode: params.exitCode ?? job.exitCode,
    commandOutput: params.output ?? job.commandOutput,
  };

  // ペアリングコード（#2524）。**コードと期限は必ず組で入れる。** 片方だけを更新すると、
  // 期限の分からないコードか、コードの無い期限が残る（どちらも掃除の条件から外れる）
  if (params.codexPairingCode && params.codexPairingExpiresAt) {
    data.codexPairingCode = params.codexPairingCode;
    data.codexPairingExpiresAt = params.codexPairingExpiresAt;
  }

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
    // **埋めた値は終わった時点で捨てる**（#2403）。トークン・キーが入りうるうえ、出力
    // （`commandOutput`）と違って後から原因を追う手掛かりにならないので、残す理由が無い
    data.placeholderValues = Prisma.DbNull;
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
      // **終わったら埋めた値を捨てる**（#2403。報告・失効と同じ）
      placeholderValues: Prisma.DbNull,
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
  planRequests: SessionPlanRequestView[];
  questionRequests: SessionQuestionRequestView[];
  concurrency: number;
}> {
  await expireStaleDispatchJobs(now);

  // セッション（#1217）を専用のエンドポイントではなくここへ足しているのは、画面側が
  // `GET /api/dispatch`と`use-dispatch-state.ts`の1本で状態を読んでいるため。取得口を
  // 増やすと、同じ画面のためにポーリングが2本走ることになる。
  const [hosts, jobs, sessions, planRequests, questionRequests, concurrency] = await Promise.all([
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
    // 計画への返事待ち（#2061）も同じ応答に載せる。**取得口を増やさない**（セッションと
    // 同じ理由で、分けると同じ画面のためにポーリングが2本走る）
    listSessionPlanRequests(now),
    // 質問への回答待ち（#2189）も同じ応答に載せる。計画の返事待ちと同じ理由
    listSessionQuestionRequests(now),
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
    // **埋めた値は画面へ返さない**（#2403）。送ったのは画面自身だが、値はシークレットで
    // ありうるうえ、画面が読む理由が無い（入力中の値はそのタブが持っている）。
    // 値を必要とするのは`POST /api/dispatch/claim`で取りに来るpollerだけ
    jobs: jobs.map((job) => ({
      ...toJobView(
        job,
        resolvedIssues.get(issueTitleKey(job.repositoryFullName, job.issueNumber)) ?? null,
      ),
      placeholderValues: null,
      resolvedCommand: null,
    })),
    sessions: sessions.map((session) => {
      const issue =
        resolvedIssues.get(issueTitleKey(session.repositoryFullName, session.issueNumber)) ?? null;
      return { ...session, issueTitle: issue?.title ?? null, issueId: issue?.id ?? null };
    }),
    planRequests,
    questionRequests,
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
  /** 手作業の代行実行を実行できるか（#1828）。申告していないpollerでは`null`＝非対応 */
  manualStepCapable: boolean | null;
  /** 走っている代行実行を止められるか（#1882）。申告していないpollerでは`null`＝非対応 */
  manualStepAbortCapable: boolean | null;
  /** 埋めた値を差し込んで代行実行できるか（#2403）。申告していないpollerでは`null`＝非対応 */
  manualStepValuesCapable: boolean | null;
  /** 計画レビュー（G1）のセッションを起こせるか（#1855）。申告していないpollerでは`null`＝非対応 */
  planReviewCapable: boolean | null;
  /** リポジトリ全体のコードレビューを起こせるか（#698）。申告していないpollerでは`null`＝非対応 */
  codeReviewCapable: boolean | null;
  /** Codex CLIでセッションを起こせるか（#2505）。申告していないpollerでは`null`＝非対応 */
  codexCapable: boolean | null;
  /**
   * Codexのペアリングコードを発行できるか（#2524）。申告していないpollerでは`null`＝非対応。
   * **`codexCapable`とは別**（`remote-control`はstandalone installのCodexでしか動かない。#2521）
   */
  codexRemoteControlCapable: boolean | null;
  selfUpdateCapable: boolean | null;
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
  /**
   * メモリ・SWAPの逼迫でpollerが起動ジョブを見送っているか（#2095）。**判定はpoller側**で、
   * ここは受け取った結果を持つだけ。見送っていない巡・申告しない古いpollerでは`null`で、
   * その場合は3列すべてを`null`へ戻す（前回の値を残すと、余力が戻った後も見送り中と出る）。
   */
  launchHold: DispatchHostLaunchHold | null;
  /**
   * pollerが動かしているチェックアウトの版（#1612）。**画面へ出すための写しで、割り当ての
   * 判定には使わない**（`metrics`と同じ立場）。申告していない・読めなかった巡では`null`で、
   * その場合は5列すべてを`null`へ戻す（前回の値を残すと、取り込む前の版が現在の版として出る）。
   */
  checkout: DispatchHostCheckout | null;
  /** 確認環境を起こせるか（#2444）。申告していないpollerでは`null`＝非対応 */
  previewCapable: boolean | null;
  /** ホストごと再起動できるか（#2496）。申告していないpollerでは`null`＝非対応 */
  rebootCapable: boolean | null;
  /**
   * 再起動が要るか・いつから起動しているか（#2496）。**画面へ出すための写しで、割り当ての
   * 判定には使わない**（`checkout`と同じ立場）。申告していない巡では`null`で、その場合は
   * 3列すべてを`null`へ戻す（前回の値を残すと、再起動済みでも「適用待ち」が出続ける）。
   */
  reboot: DispatchHostReboot | null;
  /**
   * 確認環境を起こせるリポジトリ（#2444）。`repositories`の部分集合。
   * **申告していないpollerでは`null`＝「絞り込めない」**（`repositories`をそのまま使う）。
   */
  previewRepositories: string[] | null;
  /**
   * いま動いている確認環境（#2444）。**画面へ出すための写しで、割り当ての判定には使わない**
   * （`checkout`と同じ立場）。動いていない・申告していない巡では`null`で、その場合は8列すべてを
   * `null`へ戻す（前回の値を残すと、止まっているものが動いているように出続ける）。
   */
  preview: DispatchHostPreview | null;
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
    manualStepCapable: params.manualStepCapable,
    manualStepAbortCapable: params.manualStepAbortCapable,
    manualStepValuesCapable: params.manualStepValuesCapable,
    planReviewCapable: params.planReviewCapable,
    codeReviewCapable: params.codeReviewCapable,
    codexCapable: params.codexCapable,
    codexRemoteControlCapable: params.codexRemoteControlCapable,
    selfUpdateCapable: params.selfUpdateCapable,
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
    // 起動の見送りも毎回上書きする（#2095）。**前回の値を残さない。** 残すと、余力が戻って
    // 起動を再開した後も「見送っています」が出続け、順番待ちが進まない理由を取り違える
    launchHoldReason: params.launchHold?.reason ?? null,
    launchHoldPercent: params.launchHold?.percent ?? null,
    launchHoldThresholdPercent: params.launchHold?.thresholdPercent ?? null,
    // チェックアウトの版も毎回上書きする（#1612）。**前回の値を残さない。**
    // 残すと、取り込む前の版が現在の版として出続ける（この仕組みが防ぎたいことそのもの）
    checkoutCommit: params.checkout?.commit ?? null,
    checkoutBranch: params.checkout?.branch ?? null,
    checkoutCommittedAt: toDate(params.checkout?.committedAt),
    checkoutBehind: params.checkout?.behindCount ?? null,
    checkoutFetchedAt: toDate(params.checkout?.fetchedAt),
    previewCapable: params.previewCapable,
    rebootCapable: params.rebootCapable,
    // 再起動まわりも毎回上書きする（#2496）。**前回の値を残さない。** 残すと、再起動して
    // 適用が済んだ後も「カーネル更新の適用待ち」が出続ける
    rebootRequired: params.reboot?.required ?? null,
    rebootRequiredSince: toDate(params.reboot?.requiredSince),
    bootedAt: toDate(params.reboot?.bootedAt),
    previewRepositories:
      params.previewRepositories === null ? null : JSON.stringify(params.previewRepositories),
    // 確認環境も毎回上書きする（#2444）。**前回の値を残さない。** 残すと、止まった確認環境が
    // 動いているものとして画面に出続け、押しても開けないURLだけが残る
    previewRepository: params.preview?.repository ?? null,
    previewBranch: params.preview?.branch ?? null,
    previewPort: params.preview?.port ?? null,
    previewUrl: params.preview?.url ?? null,
    previewCommit: params.preview?.commit ?? null,
    previewSubject: params.preview?.subject ?? null,
    previewStartedAt: toDate(params.preview?.startedAt),
    previewIdleMinutes: params.preview?.idleMinutes ?? null,
    lastSeenAt: now,
  };

  const host = await db.dispatchHost.upsert({
    where: { name: params.hostName },
    create: { name: params.hostName, ...values },
    update: values,
  });
  return toHostView(host, now);
}
