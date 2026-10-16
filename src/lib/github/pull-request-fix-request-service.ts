import { createHash } from "node:crypto";

/** 旧Actions修正依頼の履歴を読む。新しい依頼はIssue詳細のホスト実行から行う。 */
export const FIX_REQUEST_MARKER = "issue-deck-chat-fix-request";

export type FixScopeKind = "code" | "metadata";

/**
 * 依頼を組み立てた場所（#4482）。依頼文の1行目と「承認済み」の言い回しだけを変える。
 * `chat`はIssueDeck Chatで調査・合意したもの、`pull-request-detail`はPR詳細の対応パネルで
 * 利用者がレビュー指摘を読んで（任意で方針を書いて）送ったもの。
 */
export type FixRequestSource = "chat" | "pull-request-detail";

/** 現在のHEADに対して既に出ている修正依頼（#4482）。PR詳細が「依頼済み」を出すのに使う */
export type CurrentFixRequest = { commentUrl: string | null; createdAt: string };

/**
 * Issueのコメントから、`headSha`に対する修正依頼（どの経路から出したものでも）を探す。
 * 依頼コメントの末尾の印は`<!-- issue-deck-chat-fix-request:<key> sha=<HEAD> -->`。
 * HEADが進めば前の依頼は「現在の依頼」ではない（新しいHEADのCI・再レビューの結果で判断する）。
 */
export function findCurrentFixRequest(comments: FixRequestComment[], headSha: string): CurrentFixRequest | null {
  const latest = latestRequestFor(comments, headSha);
  if (!latest || findDispatchResult(comments, latest)) return null;
  return { commentUrl: latest.html_url ?? null, createdAt: latest.created_at ?? "" };
}

/** 中止・失敗した現在の依頼（#4639）。画面が理由を出し、同じ依頼の再送を勧めるのに使う */
export type InterruptedFixRequest = {
  kind: "aborted" | "failed";
  reason: string;
  requestUrl: string | null;
  resultUrl: string | null;
};

export function findInterruptedFixRequest(comments: FixRequestComment[], headSha: string): InterruptedFixRequest | null {
  const latest = latestRequestFor(comments, headSha);
  if (!latest) return null;
  const result = findDispatchResult(comments, latest);
  if (!result) return null;
  return { ...result.parsed, requestUrl: latest.html_url ?? null, resultUrl: result.comment.html_url ?? null };
}

export type FixRequestComment = { id?: number; body?: string | null; html_url?: string | null; created_at?: string | null };

function latestRequestFor(comments: FixRequestComment[], headSha: string): FixRequestComment | undefined {
  const pattern = new RegExp(`<!-- ${FIX_REQUEST_MARKER}:[0-9a-f]+ sha=${headSha} -->`);
  return comments.filter((comment) => comment.body && pattern.test(comment.body)).at(-1);
}

const DISPATCH_RESULT_PATTERN = /<!-- issue-deck-dispatch-result:(aborted|failed) reason=([a-z_]*) comment=(\d+) -->/;

/**
 * 依頼コメントのidを指す中止・失敗の結果コメントを探す。時刻の前後ではなく、workflowが結果コメントに
 * 書いたトリガーコメントidで結び付ける（他の`@claude`コメントの中止を取り違えない）。
 */
function findDispatchResult(
  comments: FixRequestComment[],
  request: FixRequestComment,
): { comment: FixRequestComment; parsed: { kind: "aborted" | "failed"; reason: string } } | null {
  if (request.id === undefined) return null;
  for (const comment of comments) {
    const match = comment.body ? DISPATCH_RESULT_PATTERN.exec(comment.body) : null;
    if (!match || Number(match[3]) !== request.id) continue;
    return { comment, parsed: { kind: match[1] as "aborted" | "failed", reason: match[2] } };
  }
  return null;
}

export function bodyHash(body: string | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("hex").slice(0, 16);
}

export type FixRequestFailure = {
  ok: false;
  error:
    | "not_found"
    | "not_open"
    | "no_linked_issue"
    | "head_moved"
    | "body_moved"
    | "repair_in_progress"
    | "local_session"
    | "issue_closed"
    | "reauth_required"
    | "github_error";
  message: string;
};

export type FixRequestSent = {
  ok: true;
  /** 既に同じ依頼が投稿済みで、新規には投稿しなかったとき */
  duplicate: boolean;
  commentUrl: string | null;
  issueNumber: number;
  headSha: string;
};

type Repository = { installation: { installationId: number } };
type User = { id: string; githubAccessToken: string | null; githubRefreshToken: string | null };

export async function requestPullRequestFix(
  user: User,
  repository: Repository,
  params: {
    owner: string;
    repo: string;
    number: number;
    expectedHeadSha: string;
    instruction: string;
    scope?: FixScopeKind;
    /** 調査時点のPR本文のハッシュ。`metadata`で本文が変わっていたら中断する */
    expectedBodyHash?: string;
    source?: FixRequestSource;
  },
): Promise<FixRequestSent | FixRequestFailure> {
  // API契約は旧画面・チャットからの呼び出しに対する明示的な案内のため残す。
  void user;
  void repository;
  return {
    ok: false,
    error: "local_session",
    message: `PR #${params.number} のActions経由の実装修正は廃止しました。関連Issueの詳細からホストセッションを開き、修正を依頼してください。CI失敗・コンフリクトの専用修復は引き続き利用できます。`,
  };
}
