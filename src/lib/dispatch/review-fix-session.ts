import { resolveIssueImplementationAgent } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { ReviewFixSessionRoute } from "@/types/pull-request";

export type { ReviewFixSessionRoute };

/**
 * PRのレビュー指摘を、元Issueのセッションで直させる（#5493）。
 *
 * **新しいIssue・PRは作らない**（#3965）。IssueDeckが指摘の要点・PR番号・HEAD・指摘本文への
 * リンクを書いた修正依頼をIssueコメントへ投稿し、そのIssueのセッションへ渡す。渡し方は
 * セッションの状態で3通りに分かれる（`ReviewFixSessionRoute`）。
 *
 * - 動いている（`session`）: 固定の1行（`REVIEW_FIX_SESSION_INSTRUCTION`）を`INSTRUCTION`ジョブで送る。
 *   `docs/multi-agent/gates.md`の「固定文面を1クリックで送る」に当たり、PR番号のような可変部分は
 *   **Issueコメントの側に入れ、セッションへ流すのは常にこの1行だけ**にする
 * - 終了している（`resume`）: 前回と同じホスト・エージェントで`LAUNCH`する。再開時の初回文面が
 *   「前回以降のコメント・レビュー指摘を確認して続けて」なので（`scripts/run-issue-session.sh`）、
 *   1行は送らない
 * - 記録が無い（`launch`）: 対応できるホストで`LAUNCH`する。起動時の指示ファイルの既存コメント欄に
 *   依頼が載る
 */

/**
 * 動いているセッションへ流す固定の1行。**受け口（`POST /api/pull-requests/review-fix-session`）は
 * 本文を受け取らずこれを積み、報告の受け口（`POST /api/dispatch/report`）はこれと一致する
 * `INSTRUCTION`の`succeeded`でだけ`01.check-merge`まで外す。**
 */
export const REVIEW_FIX_SESSION_INSTRUCTION =
  "IssueにPRのレビュー指摘への修正依頼コメントを追加しました。読んで、同じブランチ・同じPRで対応してください。";

export function isReviewFixSessionBody(body: string): boolean {
  return body === REVIEW_FIX_SESSION_INSTRUCTION;
}

/**
 * 送り先を決める。`session`は`findDispatchSessionForIssue`の結果（最後に報告された1件）。
 * **`ALIVE`以外でも記録が残っていれば同じホスト・エージェントで呼び戻す**——Codexで進んでいた
 * Issueが黙ってClaude Codeで立つのを防ぐため、判定は「セッションを復旧」と同じ
 * `resolveIssueImplementationAgent`。
 */
export function resolveReviewFixSessionRoute(
  session: Pick<DispatchSessionView, "host" | "state" | "codexThreadKnown"> | null,
): ReviewFixSessionRoute {
  if (!session) return { kind: "launch" };
  if (session.state === "ALIVE") return { kind: "session", host: session.host };
  return { kind: "resume", host: session.host, agent: resolveIssueImplementationAgent(session) };
}

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

/** 確認ダイアログの「送り先」欄 */
export function describeReviewFixSessionRoute(route: ReviewFixSessionRoute): string {
  switch (route.kind) {
    case "session":
      return `動いているセッションへ渡す（${route.host}）`;
    case "resume":
      return `終了したセッションを再開して渡す（${route.host}・${AGENT_LABEL[route.agent]}）`;
    case "launch":
      return "新しくセッションを起動して渡す（対応できるホストで起動）";
  }
}

/** 確認ダイアログの確定ボタン。押したときに起きることをボタン自身に言わせる */
export function reviewFixSessionActionLabel(route: ReviewFixSessionRoute): string {
  switch (route.kind) {
    case "session":
      return "セッションへ送る";
    case "resume":
      return "再開して依頼する";
    case "launch":
      return "起動して依頼する";
  }
}

export const REVIEW_FIX_NOTE_MAX_LENGTH = 1000;

export type ReviewFixRequestInput = {
  pullRequestNumber: number;
  headSha: string;
  headRef: string;
  /** 判定の文言（「要修正」「要確認」） */
  verdictLabel: string;
  /** 指摘本文のURL。読めなければnull */
  reviewUrl: string | null;
  /** 指摘の要点（`summarizeReviewConcerns`） */
  concerns: string[];
  /** 押した人が添えた方針メモ（任意） */
  note: string;
};

/**
 * Issueへ投稿する修正依頼の本文（見える部分）。**確認ダイアログはこれをそのまま全文出す**ので、
 * 画面とサーバーで同じ関数を使う。マーカーはサーバーが`buildReviewFixRequestComment`で足す。
 */
export function buildReviewFixRequestText(input: ReviewFixRequestInput): string {
  const lines = [
    `**PR #${input.pullRequestNumber} の自動レビューが「${input.verdictLabel}」でした**（HEAD \`${input.headSha.slice(0, 7)}\`）。このIssueのセッションで、同じPRを直してください。`,
    "",
  ];
  if (input.reviewUrl) lines.push(`- 指摘の全文: ${input.reviewUrl}`);
  if (input.concerns.length > 0) {
    lines.push("- 指摘の要点:");
    for (const concern of input.concerns) lines.push(`  - ${concern}`);
  }
  const note = input.note.trim();
  if (note) {
    lines.push("- 方針メモ:");
    for (const line of note.split(/\r?\n/)) lines.push(`  > ${line}`);
  }
  lines.push(
    "",
    "進め方:",
    `- 同じブランチ \`${input.headRef}\` で修正してpushしてください。新しいIssue・PRは作りません（pushするとCI・再レビューが自動で走ります）`,
    "- 仕様の選択や実機での確認が要る指摘は、推測で直さずIssueで確認してください",
  );
  return lines.join("\n");
}

/**
 * 依頼コメントの全文。末尾の印は既存の修正依頼と同じ`<!-- issue-deck-chat-fix-request:<key> sha=<HEAD> -->`
 * にして、PR詳細の「修正を依頼済み」（`findCurrentFixRequest`）と「中断した依頼」
 * （`findInterruptedFixRequest`）をそのまま効かせる。
 */
export function buildReviewFixRequestComment(params: {
  text: string;
  headSha: string;
  key: string;
  posterMarker: string;
}): string {
  return [
    params.text,
    "",
    `<!-- issue-deck-chat-fix-request:${params.key} sha=${params.headSha} -->`,
    params.posterMarker,
  ].join("\n");
}

/**
 * ジョブを積めなかったときに依頼へ付ける失敗の印。`findInterruptedFixRequest`が依頼のidで結び付け、
 * PR詳細は「依頼は届いていません」と再送の導線を出す。
 */
export function buildReviewFixFailureComment(params: {
  requestCommentId: number;
  reason: string;
  message: string;
}): string {
  const reason = params.reason.replace(/[^a-z_]/g, "_");
  return [
    `修正依頼をセッションへ渡せませんでした: ${params.message}`,
    "",
    "PR詳細の「Issueのセッションで直す」から、もう一度依頼できます。",
    "",
    `<!-- issue-deck-dispatch-result:failed reason=${reason} comment=${params.requestCommentId} -->`,
  ].join("\n");
}

/** 依頼のあとに積まれたジョブの結果。`null`はまだ結果が出ていない・成功した */
export type ReviewFixJobOutcome = {
  status: "QUEUED" | "CLAIMED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "TIMEOUT" | "CANCELED";
  message: string | null;
};

/**
 * 依頼を渡すジョブが届かずに終わったか（#5493）。届かなかったときは「依頼済み」で待たせず、
 * 「中断」として再送できるようにする。見送り（`SKIPPED`）は、承認プロンプトの表示中など
 * pollerが送らなかった場合。
 */
export function reviewFixJobFailureReason(job: ReviewFixJobOutcome | null): string | null {
  if (!job) return null;
  switch (job.status) {
    case "FAILED":
      return job.message ? `セッションへ渡せませんでした（${job.message}）` : "セッションへ渡せませんでした";
    case "SKIPPED":
      return job.message ? `送信を見送りました（${job.message}）` : "セッションが受け付けられる状態でなく、送信を見送りました";
    case "TIMEOUT":
      return "ホストが時間内に処理しませんでした";
    case "CANCELED":
      return "送信を取り消しました";
    default:
      return null;
  }
}

/** 依頼の印（`buildReviewFixRequestComment`）と、届かなかった印（`buildReviewFixFailureComment`） */
const DISPATCH_RESULT_PATTERN = /<!-- issue-deck-dispatch-result:(?:aborted|failed) reason=[a-z_]* comment=(\d+) -->/;

/**
 * Issue詳細の帯（#5493）が、そのHEADへの依頼の状態をIssueのコメントから読む。
 * `findCurrentFixRequest`はサーバー専用（`node:crypto`を読む）なので、画面用に同じ印を読む。
 * 投入後にジョブが届かなかった場合は分からない（PR詳細が`dispatchJob`まで見て「中断」を出す）。
 */
export function issueReviewFixRequestState(
  comments: readonly { id: string; body: string }[],
  headSha: string,
): "none" | "requested" | "interrupted" {
  const pattern = new RegExp(`<!-- issue-deck-chat-fix-request:[0-9a-f]+ sha=${headSha} -->`);
  const request = comments.filter((comment) => pattern.test(comment.body)).at(-1);
  if (!request) return "none";
  const failed = comments.some((comment) => DISPATCH_RESULT_PATTERN.exec(comment.body)?.[1] === request.id);
  return failed ? "interrupted" : "requested";
}
