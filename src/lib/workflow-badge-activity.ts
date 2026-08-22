import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * 一覧の進捗バッジ（`WorkflowStepBadge`）の外周リングを回すかどうかの判定（#1439）。
 *
 * **回転が意味するのは「今この瞬間、エージェント側が動いている」の一点だけ。** 人の入力を
 * 待っている状態・終わった状態・報告が途絶えた状態では回さない。回転は一覧を流し見したときに
 * 最初に目に入る動きなので、「動いていないのに回っている」を許すと合図として使えなくなる。
 *
 * 判定は実行先（GitHub Actions／サブPC）で材料が変わる。**両方をここに集めているのは、
 * 条件がコンポーネントの式へ散ると片方だけ直された状態になりやすいため**（#1262でサブPCの
 * 誤警告を消したときも、回転の条件だけがActions前提のまま残った）。
 *
 * | 実行先 | 状態 | 回す |
 * |---|---|---|
 * | Actions | `actionsRunning.isRunning === true` | ○ |
 * | Actions | ポーリング結果が未取得（`undefined`）・実行が無い | × |
 * | サブPC | セッションが`ALIVE`で`activity`が`null`/`WORKING`/`RESPONDED` | ○ |
 * | サブPC | セッションが`ALIVE`だが`activity === "WAITING_INPUT"` | × |
 * | サブPC | セッションが`ALIVE`だが`activity === "NOT_STARTED"`（#1465） | × |
 * | サブPC | `EXITED`/`FAILED`/`GONE` | × |
 * | サブPC | `ALIVE`だが`lastReportedAt`が{@link SESSION_ACTIVITY_STALE_MS}より古い | × |
 * | 共通 | 承認待ち（`00.check-user`） | × |
 *
 * `RESPONDED`（応答を終えた）を回す側に含めるのは、`summarizeIssueSession`が同じものを
 * tone`running`として扱っているため（`src/lib/dispatch/issue-session.ts`）。判定を2種類に割ると、
 * 同じ画面の別の場所で「実行中」と「実行中でない」が同時に出る。
 *
 * 承認待ちを回さない側に置いているのは、バッジ中央にアラートアイコンが重なって「人が対応する番」を
 * 示す状態だから。回転（＝エージェントが動いている）と同時に出すと合図が矛盾する。Actions側は
 * ポーリング自体が承認待ちのIssueを外している（`use-issues-workflow-running.ts`）ので、これは
 * サブPC側にも同じ扱いを広げるもの。
 *
 * 運用の背景は`docs/multi-agent/session-notify.md`「実行中の回転はどこから決まるか（#1439）」。
 */

/**
 * セッションの報告がこれより古ければ、`ALIVE`でも動いているとみなさない。
 *
 * pollerは1巡（既定30秒）ごとに`lastReportedAt`を更新するため、5分の無音はサブPC側が
 * 落ちている（あるいはpollerが止まっている）ことを意味する。**この歯止めが無いと、サブPCが
 * 落ちたIssueのバッジが誰も止められないまま回り続ける**（状態は`GONE`にならない。`GONE`へ
 * 進めるのもpollerの報告のため）。
 *
 * `DISPATCH_HOST_ONLINE_WINDOW_MS`と同じ5分だが、あちらはホストの生存、こちらはセッション報告の
 * 鮮度で、見ている列も更新の経路も違うため定数は分けている。
 */
export const SESSION_ACTIVITY_STALE_MS = 5 * 60 * 1000;

/** 判定に使うセッションの項目だけ。テストから最小限の値で呼べるようにしている */
export type WorkflowBadgeSession = Pick<
  DispatchSessionView,
  "state" | "activity" | "lastReportedAt"
>;

export function isWorkflowBadgeSpinning(params: {
  /** GitHub Actionsの実行状況（`useIssuesWorkflowRunning`の結果）。未取得ならundefined */
  actionsRunning?: { isRunning: boolean } | null;
  /** そのIssueのセッション（#1264・`findSessionForIssue`の結果）。無ければnull */
  session?: WorkflowBadgeSession | null;
  /** `00.check-user`が付いているか */
  approvalPending: boolean;
  /** 現在時刻(epoch ms)。マウント前などで未取得(null)のときは古さの判定を行わない */
  now: number | null;
}): boolean {
  const { actionsRunning, session, approvalPending, now } = params;
  if (approvalPending) return false;
  if (actionsRunning?.isRunning) return true;
  return isSessionActivelyWorking(session ?? null, now);
}

/**
 * サブPCのセッションが「今まさに作業している」と言える状態か。
 *
 * `isSessionWaitingInput`（`src/lib/dispatch/issue-session.ts`）の裏返しではない。あちらは
 * 入力待ちだけを見るが、こちらは終了・報告の途絶も除く必要がある。
 *
 * **確認待ちを数えるかどうかの判定（`lib/check-user-attention.ts`・#2174）からも呼ぶ。**
 * バッジの回転と同じ材料で「いまエージェントが動いているか」を決めるため、判定はここ1か所に置く。
 */
export function isSessionActivelyWorking(
  session: WorkflowBadgeSession | null,
  now: number | null,
): boolean {
  if (!session) return false;
  if (session.state !== "ALIVE") return false;
  if (session.activity === "WAITING_INPUT") return false;
  // Claude Codeがまだ開始していない（#1465）。tmuxのペインは生きているが、動いているのは
  // 起動確認の画面だけで、エージェントは1行も動いていない
  if (session.activity === "NOT_STARTED") return false;
  if (now !== null) {
    const reportedAt = Date.parse(session.lastReportedAt);
    // 解釈できない値は判定材料にしない（古さで消すより、状態の方を信じる）
    if (Number.isFinite(reportedAt) && now - reportedAt > SESSION_ACTIVITY_STALE_MS) return false;
  }
  return true;
}
