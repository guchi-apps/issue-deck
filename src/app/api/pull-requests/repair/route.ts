import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  canRepairFromDeck,
  resolveRepairDispatch,
  type RepairKind,
} from "@/lib/github/pull-request-repair";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { dispatchWorkflow } from "@/lib/github/workflow-dispatch";
import { previewModeGuard } from "@/lib/preview-mode";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

function isRepairKind(value: unknown): value is RepairKind {
  return value === "ci" || value === "conflict";
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_repair", () => handlePOST(request));
}

/**
 * 詰まっているPRの自動修復ワークフローを画面のボタンから起動する（#1293）。
 *
 * **起動先の判定はサーバー側で行う。** クライアントが持つ`PullRequestSummary`にも
 * base/headはあるが、それを信用すると「Issue用のワークフローへ無関係なIssue番号を渡す」
 * といった呼び方が成立してしまう。PRを取り直して実際のbase/head・open状態から決める。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { owner?: string; repo?: string; number?: number; kind?: string } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number, kind } = body;

  if (!owner || !repo || !number || Number.isNaN(Number(number)) || !isRepairKind(kind)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pullRequest = await fetchPullRequest(owner, repo, Number(number), token);

    if (
      !canRepairFromDeck({
        state: pullRequest.state === "closed" ? "closed" : "open",
        draft: pullRequest.draft,
      })
    ) {
      return NextResponse.json(
        {
          error: "not_repairable",
          message: "クローズ済み・ドラフトのPull Requestは自動修復の対象外です。",
        },
        { status: 409 },
      );
    }

    const dispatch = resolveRepairDispatch(
      {
        number: pullRequest.number,
        baseRef: pullRequest.base.ref,
        headRef: pullRequest.head.ref,
      },
      kind,
    );

    await dispatchWorkflow(
      owner,
      repo,
      dispatch.workflowFile,
      dispatch.ref,
      dispatch.inputs,
      token,
    );

    return NextResponse.json({ ok: true, workflowFile: dispatch.workflowFile });
  } catch (error) {
    // ワークフロー自体が無いリポジトリ・デフォルトブランチへ未反映の場合は404が返る。
    // 「押しても起動しない」理由が分かるよう、汎用のAPIエラーと区別して文言を返す。
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json(
        {
          error: "workflow_not_found",
          message:
            "自動修復のworkflowがこのリポジトリで見つかりませんでした（デフォルトブランチへ未反映の可能性があります）。",
        },
        { status: 404 },
      );
    }
    console.error(`[POST /api/pull-requests/repair] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
