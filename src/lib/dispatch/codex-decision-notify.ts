import { resolveIssueImplementationAgent } from "@/lib/dispatch/issue-session";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";

/**
 * 画面から送った計画の判断・質問の回答を、**Codexのローカルセッションへ届ける**（#3218）。
 *
 * Claude Codeでは要らない。あちらは`ExitPlanMode`・`AskUserQuestion`のフックが
 * `GET /api/dispatch/sessions/{plan,question}/decision`を引き続けて待ち、返ってきた結論を
 * そのまま許可判定として使う——待っているのはツール呼び出しの内側なので、待つ間にターンは終わらない。
 *
 * **Codexにはそれが無い。** 計画・質問は`scripts/submit-plan.sh`・`scripts/submit-question.sh`
 * を実行して登録するが、Codexはシェルの実行を`yield_time_ms: 30000`で打ち切り、打ち切られた
 * 出力を「`Script completed` / `Wall time 30.2 seconds`」として受け取る。**まだ走っているとは
 * 書かれない**ため、Codexは完了と解釈してそのターンを終える（ops-dashboard#302の実測では、
 * スクリプト自身は162秒後に修正依頼を受け取って正常終了していたが、受け取る当事者はもういなかった）。
 *
 * #3179はこれを`submit-plan.sh`の中から`codex queue`を打つ形で埋めようとしたが、
 * **セッションの内側からは打てない**。Codexのサンドボックスが書込みを許すのはworktree・`/tmp`・
 * `$TMPDIR`・対象リポジトリの`.git`だけで、`~/.codex`のstate DB（SQLite）は読み取り専用になる
 * （`attempt to write a readonly database`）。2026-09-20の失敗5件は偶発ではない。
 *
 * そこで**送る場所をサンドボックスの外へ出す**。判断が決まった時点でissue-deckが`INSTRUCTION`
 * ジョブを積み、pollerが`deliver_codex_instruction`（`scripts/lib/codex-queue.sh`）から
 * `codex queue`で送る。pollerは通常のユーザー権限で走っているので`~/.codex`へ書ける。
 *
 * **`send-keys`は通らないので、`docs/multi-agent/gates.md`の例外は開けない。** `codex queue`は
 * キー入力を経由せず次のターンの頭へ積むだけで、選択フォームの表示中に勝手に回答済みになる事故を
 * 起こせない（`scripts/lib/codex-queue.sh`の冒頭に同じことが書いてある）。そのため送り先は
 * **Codexのセッションに限る**——Claude Codeのセッションへ積むと、pollerは`send-keys`の3段階
 * プロトコルの方へ倒し、人の操作を挟まない自動の`send-keys`になってしまう。
 */

/** 計画が承認されたとき */
export const CODEX_PLAN_APPROVED_INSTRUCTION =
  "issue-deckの画面で計画が承認されました。承認済みの計画に従って実装・検証・コミット・PR作成を続けてください。";

/** 計画の修正が求められたとき */
export const CODEX_PLAN_REVISION_INSTRUCTION =
  "issue-deckの画面で計画の修正が求められました。Issueの最新のコメントで修正の内容を読み、計画へ反映して同じコマンドで再送してください。";

/** 質問へ回答があったとき */
export const CODEX_QUESTION_ANSWERED_INSTRUCTION =
  "issue-deckの画面で質問へ回答がありました。Issueの最新のコメントで回答を読み、それに沿って作業を続けてください。";

export type CodexDecisionKind = "plan-approved" | "plan-revision" | "question-answered";

/**
 * 送る本文は**この表にあるものだけ**。
 *
 * 修正の本文・回答の内容はここへ載せない。`DispatchJob.instruction`は改行を含まない500字までで、
 * 人が書いた長い文章は入らないうえ、**実行体が本文を組み立てない**という線（gates.md）からも外れる。
 * どちらも判断と同時にIssueコメントとして投稿済み（`buildSessionPlanDecisionCommentBody`・
 * `buildSessionQuestionAnswerCommentBody`）なので、そこを読ませる。
 */
export const CODEX_DECISION_INSTRUCTIONS: Record<CodexDecisionKind, string> = {
  "plan-approved": CODEX_PLAN_APPROVED_INSTRUCTION,
  "plan-revision": CODEX_PLAN_REVISION_INSTRUCTION,
  "question-answered": CODEX_QUESTION_ANSWERED_INSTRUCTION,
};

export type CodexDecisionNotifySkip =
  /** そのIssueのセッションの記録が無い（終わって24時間以上経った・まだ報告が無い） */
  | "no_session"
  /** Claude Codeのセッション。フックが判断を受け取るので、ここからは何もしない */
  | "not_codex"
  /** Codexのセッションだが、もう動いていない */
  | "not_alive";

export type CodexDecisionNotifyResult =
  | { ok: true; jobId: string }
  /** 送らなかった／送れなかった。**呼び出し元は成功として返す**（判断自体はもう確定している） */
  | { ok: false; reason: CodexDecisionNotifySkip | string; message: string };

/**
 * 判断が決まったことをCodexのセッションへ知らせる。
 *
 * **失敗させない。** 判断は既にDBとIssueコメントへ入っていて、ここは「新しいターンを起こす」だけ。
 * 届かなかった場合は端末から続けられるし、セッションが終わっていれば既存の「セッションを復旧」で
 * 呼び戻せる。呼び出し元はこの戻り値を記録に使うだけで、HTTPの結果は変えない。
 */
export async function notifyCodexSessionDecision(params: {
  repositoryFullName: string;
  issueNumber: number;
  kind: CodexDecisionKind;
  requestedByUserId: string | null;
}): Promise<CodexDecisionNotifyResult> {
  const session = await findDispatchSessionForIssue({
    repositoryFullName: params.repositoryFullName,
    issueNumber: params.issueNumber,
  });
  if (!session) {
    return { ok: false, reason: "no_session", message: "セッションの記録がありません。" };
  }
  if (resolveIssueImplementationAgent(session) !== "codex") {
    return { ok: false, reason: "not_codex", message: "Codexのセッションではありません。" };
  }
  if (session.state !== "ALIVE") {
    return {
      ok: false,
      reason: "not_alive",
      message: "Codexのセッションが動いていません。「セッションを復旧」から呼び戻してください。",
    };
  }

  const result = await enqueueSessionControlJob({
    repositoryFullName: params.repositoryFullName,
    issueNumber: params.issueNumber,
    hostName: session.host,
    kind: "INSTRUCTION",
    instruction: CODEX_DECISION_INSTRUCTIONS[params.kind],
    // **`recovery`は立てない**（#2886・#2919）。あれは「届いたことを確かめてから`00.check-user`を
    // 外す」ための印で、計画・質問の確認待ちは判断を押した時点で`resolveSessionPlanCheckUser`が
    // 既に外している（#2341）。ここで立てると同じラベルを2か所から外すことになる
    requestedByUserId: params.requestedByUserId,
  });
  if (!result.ok) {
    return { ok: false, reason: result.rejection, message: result.message };
  }
  return { ok: true, jobId: result.job.id };
}
