import { createHash } from "node:crypto";

import { redactSecrets } from "@/lib/chat/investigation/redact";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue, createComment } from "@/lib/github/issues-api";
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

export type FixRequestFailure = {
  ok: false;
  error:
    | "not_found"
    | "not_open"
    | "no_linked_issue"
    | "head_moved"
    | "repair_in_progress"
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
}): string {
  return [
    `@claude PR #${params.number}（HEAD ${params.headSha.slice(0, 7)}）の修正をお願いします。チャットでの調査と合意に基づく依頼です。`,
    "",
    redactSecrets(params.instruction.trim()),
    "",
    FIX_REQUEST_SCOPE,
    "修正後はテスト・lint・型チェックを実行し、結果と残課題をこのIssueへコメントしてください。同じPRのブランチへpushし、新しいPRは作らないでください。",
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
    const key = fixRequestKey(fullName, number, pr.head.sha, params.instruction);
    const existing = (await fetchCommentsForIssue(owner, repo, issueNumber, token)).find((c) =>
      c.body?.includes(`${FIX_REQUEST_MARKER}:${key}`),
    );
    if (existing) {
      return { ok: true, duplicate: true, commentUrl: existing.html_url ?? null, issueNumber, headSha: pr.head.sha };
    }
    const active = await fetchActivePullRequestRepairRun(fullName, number);
    if (active) {
      return {
        ok: false,
        error: "repair_in_progress",
        message: "このPRは現在自動修正中です。完了してから依頼してください。",
      };
    }
    const body = buildFixRequestBody({ number, headSha: pr.head.sha, instruction: params.instruction, key });
    const posted = await withUserGithubToken(user, `chat fix-request ${fullName}#${number}`, (userToken) =>
      createComment(owner, repo, issueNumber, userToken, { body }),
    );
    if ("errorResponse" in posted) {
      const detail = await posted.errorResponse.json().catch(() => ({}));
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
