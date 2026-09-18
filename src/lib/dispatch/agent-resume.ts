import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * 一括停止したセッションを画面から再開させるための固定文面と判定（#3045）。
 *
 * **DBにもGitHubにも触らない純粋関数だけを置く**（`session-stall.ts`と同じ立場）。呼ぶのは
 * エージェント別の一括操作パネル（`agent-bulk-control-panel.tsx`。対象の目安を出す）と、
 * 押されたときの受け口（`POST /api/dispatch/agent-resume`。実際に送る対象を決める）の両方で、
 * **同じ関数から引く**（画面だけ緩いと、対象に見えたのに送られない・その逆が生まれる）。
 *
 * ## `docs/multi-agent/gates.md`との関係
 *
 * 送るのは**この定数の固定の1行だけ**で、状況を読んで本文を組み立てる実行体は無い。押すのは人で、
 * 送出は既存の追加指示（#1012）の3段階プロトコルをそのまま通る——承認プロンプト・選択フォームの
 * 表示中は従来どおり見送られる。gates.mdの例外2の内側（CLAUDE.mdでは「画面が用意した固定文面を
 * 1クリックで送る」の項目）で、選択肢の確定は引き続き画面から行わない。
 */

/**
 * 再開のときに送る固定の1行。**1行・制御文字なし・500文字以内**で、先頭を`/`や`!`にしない
 * （スラッシュコマンド・Bashモードとして解釈されるため。`parseSessionInstruction`が通る形）。
 */
export const AGENT_RESUME_INSTRUCTION =
  "一括停止で中断していました。再開します。中断したところから作業を続けてください。";

export function isAgentResumeBody(body: string): boolean {
  return body === AGENT_RESUME_INSTRUCTION;
}

/**
 * C-cを送った完了時刻から、この時間より後に動きがあれば「もう動き出している」と見る。
 * 中断した直後にツールの後始末のフックが飛ぶことがあるため、少しだけ猶予を持たせる。
 */
export const AGENT_RESUME_ACTIVITY_GRACE_MS = 30_000;

type StoppedSessionCandidate = Pick<
  DispatchSessionView,
  | "host"
  | "repositoryFullName"
  | "issueNumber"
  | "state"
  | "activity"
  | "activityAt"
  | "stepSeenAt"
>;

type InterruptJobLite = Pick<
  DispatchJobView,
  "kind" | "status" | "targetHost" | "repositoryFullName" | "issueNumber" | "finishedAt"
>;

function jobKey(host: string, repositoryFullName: string, issueNumber: number): string {
  return JSON.stringify([host, repositoryFullName, issueNumber]);
}

function toMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 「一括停止で止まったまま」のセッションを選ぶ。**スキーマに何も足さず、既存の記録から引く。**
 *
 * 条件は4つ。すべて満たしたものだけを返す。
 * - セッションが生きている（`ALIVE`）。畳まれたセッションには送る相手がいない
 * - 成功した`INTERRUPT`ジョブがある（同じホスト・リポジトリ・Issue。複数あれば最後のもの）
 * - その完了時刻より後に`activityAt`・`stepSeenAt`が進んでいない。**Claude Codeは中断（C-c）では
 *   `Stop`フックを飛ばさない**ので、止めた後の`activityAt`は中断時点のまま止まる。ツールの実行
 *   （`stepSeenAt`）まで見るのは、人が端末から続けた場合に`activityAt`だけが進まないことがあるため
 *   （`describeSessionStall`と同じ「動いたか」の見方）。進んでいれば、もう動き出している
 * - **中断の時点で作業中だった**（下の`wasWorking`）。一括停止はALIVEなセッションすべてへC-cを送るので、
 *   人の答えを待っていた（質問・承認待ち）、または応答を終えて待機していたセッションも「中断の
 *   記録がある」。それらへ「続けて」と送ると、答えていないのに作業が進む
 *
 * `sessions`は呼び出し側でエージェント（Claude Code・Codex CLI）を絞ってから渡す。
 */
export function selectStoppedSessions<S extends StoppedSessionCandidate>(
  sessions: readonly S[],
  jobs: readonly InterruptJobLite[],
): S[] {
  const latestInterrupt = new Map<string, number>();
  for (const job of jobs) {
    if (job.kind !== "INTERRUPT" || job.status !== "SUCCEEDED" || !job.finishedAt) continue;
    const finishedAt = new Date(job.finishedAt).getTime();
    if (Number.isNaN(finishedAt)) continue;
    const key = jobKey(job.targetHost, job.repositoryFullName, job.issueNumber);
    const previous = latestInterrupt.get(key);
    if (previous === undefined || finishedAt > previous) latestInterrupt.set(key, finishedAt);
  }

  return sessions.filter((session) => {
    if (session.state !== "ALIVE") return false;
    const interruptedAt = latestInterrupt.get(
      jobKey(session.host, session.repositoryFullName, session.issueNumber),
    );
    if (interruptedAt === undefined) return false;

    const activityAt = toMs(session.activityAt);
    const stepSeenAt = toMs(session.stepSeenAt);
    const limit = interruptedAt + AGENT_RESUME_ACTIVITY_GRACE_MS;
    if ((activityAt ?? 0) > limit || (stepSeenAt ?? 0) > limit) return false;

    return wasWorking(session, activityAt, stepSeenAt);
  });
}

/**
 * 中断の時点で作業中だったか。**`activity`の`WORKING`は使えない**——承認に答えた直後にしか報告
 * されず、作業中ずっと立っている値ではない（`session-state.ts`）。代わりに、次の順で「待っていた」
 * ものを外す。
 * - `WAITING_INPUT`（質問・承認プロンプトで人の答えを待っていた）・`NOT_STARTED`（まだ始まっていない）
 * - **`Stop`（`activityAt`）が最後のツール実行（`stepSeenAt`）より新しい**＝ターンを終えて次の入力を
 *   待っていた（マージ待ち・`01.check-input`など）。ツールがまだ走っていたなら`stepSeenAt`の方が新しい
 *
 * どちらの手掛かりも無いセッション（フックの報告が無い）は判断できないので、対象に含める。
 */
function wasWorking(
  session: Pick<StoppedSessionCandidate, "activity">,
  activityAt: number | null,
  stepSeenAt: number | null,
): boolean {
  if (session.activity === "WAITING_INPUT" || session.activity === "NOT_STARTED") return false;
  if (session.activity === "RESPONDED" && activityAt !== null) {
    return stepSeenAt !== null && stepSeenAt > activityAt;
  }
  return true;
}
