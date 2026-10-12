import { createHash } from "node:crypto";

import { redactSecrets } from "@/lib/chat/investigation/redact";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue, fetchIssueLabelNames, fetchIssueState, createComment } from "@/lib/github/issues-api";
import { fetchActivePullRequestRepairRun } from "@/lib/github/pull-request-repair-run";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";

/**
 * 利用者が明示した修正依頼を、**同じPRの修正**として既存の実行系へ渡す（#4045）。
 *
 * 既存の自動修正（`startPullRequestRepair`）は「CI失敗・コンフリクト・自動レビューの要修正」だけが
 * 起動条件で、needs-checkのPRや、会話で合意した方針での修正は受け付けない。実行系のロジックを
 * 複製せず、Issue詳細の「実装を開始」と同じ`@claude`コメントでPRのブランチ（`issue-<番号>`）の
 * 追加対応として渡す。実行先・エージェント・モデルは`claude-issue-dispatch`と担当引き継ぎの既存設定が決める。
 *
 * - 依頼を組み立てた時点のHEADから進んでいたら、**古い前提で直させない**ため中断する
 * - 同じ依頼（PR・HEAD・本文が同じ）の再送は、既に投稿済みのコメントを返す（二重実行しない）
 * - 依頼コメントは利用者本人のトークンで投稿する（ボットのコメントは実行系が受けない）
 */

export const FIX_REQUEST_MARKER = "issue-deck-chat-fix-request";

/** 実行系へ渡す許可範囲。コメント・ログ・コードの記述ではなく、ここで固定する */
export const FIX_REQUEST_SCOPE =
  "許可範囲: このPRのブランチ内のコード・テスト・ドキュメントの修正のみ。マージ・本番反映・認証方式や環境変数・Secretsの変更はしない。判断が要る点は実装せずIssueコメントで相談する。";

/** 管理情報（PR本文・関連Issue本文）だけを直す依頼の許可範囲。コード変更・push・別PRは作らせない（#4153） */
export const FIX_REQUEST_SCOPE_METADATA =
  "許可範囲: このPR本文と、紐づく親Issue本文の追跡情報（PRの役割・残作業の記載・関連付け）の更新のみ。コミット・push・新しいPRは作らない。既存の要件の削除や完了条件の縮小、マージ・本番反映・認証方式や環境変数・Secretsの変更はしない。判断が要る点は実装せずIssueコメントで相談する。";

export type FixScopeKind = "code" | "metadata";

/**
 * 依頼を組み立てた場所（#4482）。依頼文の1行目と「承認済み」の言い回しだけを変える。
 * `chat`はIssueDeck Chatで調査・合意したもの、`pull-request-detail`はPR詳細の対応パネルで
 * 利用者がレビュー指摘を読んで（任意で方針を書いて）送ったもの。
 */
export type FixRequestSource = "chat" | "pull-request-detail";

/** 依頼先Issueに付いているとdispatchが反応しないラベル（ローカルセッションで対応中） */
const LOCAL_SESSION_LABEL = "11.local";

/** 現在のHEADに対して既に出ている修正依頼（#4482）。PR詳細が「依頼済み」を出すのに使う */
export type CurrentFixRequest = { commentUrl: string | null; createdAt: string };

/**
 * Issueのコメントから、`headSha`に対する修正依頼（どの経路から出したものでも）を探す。
 * 依頼コメントの末尾の印は`<!-- issue-deck-chat-fix-request:<key> sha=<HEAD> -->`。
 * HEADが進めば前の依頼は「現在の依頼」ではない（新しいHEADのCI・再レビューの結果で判断する）。
 */
export function findCurrentFixRequest(
  comments: { body?: string | null; html_url?: string | null; created_at?: string | null }[],
  headSha: string,
): CurrentFixRequest | null {
  const pattern = new RegExp(`<!-- ${FIX_REQUEST_MARKER}:[0-9a-f]+ sha=${headSha} -->`);
  const matched = comments.filter((comment) => comment.body && pattern.test(comment.body));
  const latest = matched.at(-1);
  if (!latest) return null;
  return { commentUrl: latest.html_url ?? null, createdAt: latest.created_at ?? "" };
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

export function fixRequestKey(repo: string, number: number, headSha: string, instruction: string): string {
  return createHash("sha256").update(`${repo}#${number}:${headSha}:${instruction}`).digest("hex").slice(0, 16);
}

export function buildFixRequestBody(params: {
  number: number;
  headSha: string;
  instruction: string;
  key: string;
  scope?: FixScopeKind;
  source?: FixRequestSource;
}): string {
  const metadata = params.scope === "metadata";
  const fromDetail = params.source === "pull-request-detail";
  return [
    fromDetail
      ? `@claude PR #${params.number}（HEAD ${params.headSha.slice(0, 7)}）の自動レビューの指摘への対応をお願いします。PR詳細の対応パネルから利用者が送った依頼です。`
      : `@claude PR #${params.number}（HEAD ${params.headSha.slice(0, 7)}）の修正をお願いします。チャットでの調査と合意に基づく依頼です。`,
    "",
    redactSecrets(params.instruction.trim()),
    "",
    fromDetail
      ? "この依頼は、利用者がレビュー指摘を読んだうえで送ったものです。上に方針が書かれていればそれは回答済みとして扱ってください。方針が書かれていない点で仕様の選択や実機での確認が要るものは、推測で直さずIssueコメントで質問してください。"
      : "この依頼は、利用者がチャットで原因と方針を確認して承認したものです。上の方針は回答済みとして扱い、同じ方針の質問で停止しないでください。",
    "",
    metadata ? FIX_REQUEST_SCOPE_METADATA : FIX_REQUEST_SCOPE,
    metadata
      ? "更新したPR本文・Issue本文の変更箇所と、元の指摘がどう解消したかをこのIssueへコメントしてください。コミット・pushはしないでください（HEADが変わらなくても未修正ではありません）。"
      : "修正後はテスト・lint・型チェックを実行し、結果と残課題をこのIssueへコメントしてください。同じPRのブランチへpushし、新しいPRは作らないでください。",
    "",
    `<!-- ${FIX_REQUEST_MARKER}:${params.key} sha=${params.headSha} -->`,
  ].join("\n");
}

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
  const { owner, repo, number } = params;
  const fullName = `${owner}/${repo}`;
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, number, token);
    if (pr.state !== "open" || pr.merged) {
      return { ok: false, error: "not_open", message: "このPRはすでにクローズ・マージされています。" };
    }
    const match = /^issue-(\d+)$/.exec(pr.head.ref);
    if (!match) {
      return {
        ok: false,
        error: "no_linked_issue",
        message: `${pr.head.ref} は issue-<番号> ブランチではないため、依頼を渡すIssueがありません。PRの詳細から直接ご依頼ください。`,
      };
    }
    const issueNumber = Number(match[1]);
    if (pr.head.sha !== params.expectedHeadSha) {
      return {
        ok: false,
        error: "head_moved",
        message: `調査したHEAD（${params.expectedHeadSha.slice(0, 7)}）から進んでいます（現在 ${pr.head.sha.slice(0, 7)}）。古い前提で直さないよう中断しました。もう一度調べ直してください。`,
      };
    }
    if (params.scope === "metadata" && params.expectedBodyHash && bodyHash(pr.body) !== params.expectedBodyHash) {
      return {
        ok: false,
        error: "body_moved",
        message: "調査後にPR本文が更新されています。古い前提で上書きしないよう中断しました。もう一度調べ直してください。",
      };
    }
    const key = fixRequestKey(fullName, number, pr.head.sha, `${params.scope ?? "code"}:${params.instruction}`);
    const existing = (await fetchCommentsForIssue(owner, repo, issueNumber, token)).find((c) =>
      c.body?.includes(`${FIX_REQUEST_MARKER}:${key}`),
    );
    if (existing) {
      return { ok: true, duplicate: true, commentUrl: existing.html_url ?? null, issueNumber, headSha: pr.head.sha };
    }
    // ローカルセッションで対応中のIssueへ`@claude`を書いても、dispatchは反応しない（#4482）。
    // 投稿だけして「依頼済み」に見せると、誰も直さないまま止まる
    const [labels, issueState] = await Promise.all([
      fetchIssueLabelNames(owner, repo, issueNumber, token),
      fetchIssueState(owner, repo, issueNumber, token),
    ]);
    // closedのIssueへの`@claude`もdispatchは黙ってskipする（`reusable-issue-dispatch.yml`の`ISSUE_CLOSED`）
    if (issueState === "closed") {
      return {
        ok: false,
        error: "issue_closed",
        message: `Issue #${issueNumber} はクローズ済みのため、ここからの依頼は実行されません。Issueを再オープンするか、修正Issueを起案してください。`,
      };
    }
    if (labels.includes(LOCAL_SESSION_LABEL)) {
      return {
        ok: false,
        error: "local_session",
        message: `Issue #${issueNumber} はローカルセッションで対応中（${LOCAL_SESSION_LABEL}）のため、ここからの依頼は実行されません。Issue詳細から実行中のセッションへ修正を依頼してください。`,
      };
    }
    const active = await fetchActivePullRequestRepairRun(fullName, number);
    if (active) {
      return {
        ok: false,
        error: "repair_in_progress",
        message: "このPRは現在自動修正中です。完了してから依頼してください。",
      };
    }
    const body = buildFixRequestBody({
      number,
      headSha: pr.head.sha,
      instruction: params.instruction,
      key,
      scope: params.scope,
      source: params.source,
    });
    const posted = await withUserGithubToken(user, `chat fix-request ${fullName}#${number}`, (userToken) =>
      createComment(owner, repo, issueNumber, userToken, { body }),
    );
    if ("errorResponse" in posted) {
      const detail = await posted.errorResponse.json().catch(() => ({}));
      if (detail?.error === "github_reauth_required") {
        return {
          ok: false,
          error: "reauth_required",
          message: "GitHubの連携が切れているため、あなたの名前で依頼を投稿できません。ログインし直してから送ってください。",
        };
      }
      return {
        ok: false,
        error: "github_error",
        message: typeof detail?.message === "string" ? detail.message : "依頼コメントを投稿できませんでした。",
      };
    }
    return {
      ok: true,
      duplicate: false,
      commentUrl: posted.value.html_url ?? null,
      issueNumber,
      headSha: pr.head.sha,
    };
  } catch (error) {
    return {
      ok: false,
      error: "github_error",
      message: `GitHubへの接続に失敗しました。${error instanceof Error ? redactSecrets(error.message).slice(0, 120) : ""}`.trim(),
    };
  }
}
