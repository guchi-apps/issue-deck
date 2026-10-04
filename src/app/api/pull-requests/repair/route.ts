import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  canRepairFromDeck,
  repairKindsFor,
  resolveRepairDispatch,
} from "@/lib/github/pull-request-repair";
import {
  fetchActivePullRequestRepairRun,
  isRepairSymptomGone,
  recordPullRequestRepairRun,
} from "@/lib/github/pull-request-repair-run";
import { AUTO_REPAIR_MAX_ROUNDS } from "@/lib/github/pull-request-repair-loop";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchPullRequestCiState } from "@/lib/github/release-api";
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

  const body: { owner?: string; repo?: string; number?: number } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number } = body;

  if (!owner || !repo || !number || Number.isNaN(Number(number))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pullRequest = await fetchPullRequest(owner, repo, Number(number), token);
    const currentState = await fetchPullRequestCiState(owner, repo, Number(number), token);

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

    const activeRepair = await fetchActivePullRequestRepairRun(
      `${owner}/${repo}`,
      pullRequest.number,
    );
    // 終了報告が届かない旧workflowではDBにrunningが残ることがある。画面表示と同じく、
    // 現在のPR状態で元の症状が既に解消していれば、その古い記録で次の修復を止めない。
    const activeRepairStillRelevant =
      activeRepair !== null &&
      !isRepairSymptomGone(activeRepair.kind, {
        mergeable: currentState.mergeable,
        ciState: currentState.ciState,
      });
    if (activeRepairStillRelevant) {
      return NextResponse.json(
        {
          error: "repair_in_progress",
          message: "このPRは現在自動修正中です。完了してからもう一度実行してください。",
        },
        { status: 409 },
      );
    }

    // 画面に表示した時点の状態を信用せず、実行時のHEADから対象を組み立て直す。
    // これによりCIとレビューが同時にNGでも、利用者が実行順を選ぶ必要がない。
    const kinds = repairKindsFor(
      {
        state: pullRequest.state === "closed" ? "closed" : "open",
        draft: pullRequest.draft,
        ciState: currentState.ciState,
        baseRef: pullRequest.base.ref,
        headRef: pullRequest.head.ref,
        reviewVerdict: parsePullRequestReviewVerdict(pullRequest.body),
      },
      currentState.mergeable,
    );
    if (kinds.length === 0) {
      return NextResponse.json(
        {
          error: "not_repairable",
          message: "このPRには現在、自動修正できる問題が見つかりませんでした。",
        },
        { status: 409 },
      );
    }
    // 同じIssueブランチの修復workflowは同一concurrency groupを共有する。GitHub Actionsは
    // running 1件 + pending 1件しか保持しないため複数を一度にdispatchせず、優先順位
    // conflict → ci → review（repairKindsForの順）の先頭だけを起動する。完了後にPRを再取得し、
    // まだ問題が残っていれば同じ「PRを自動修正」から次を実行する。
    const kind = kinds[0];
    const dispatch = resolveRepairDispatch(
      { number: pullRequest.number, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref },
      kind,
    );
    // workflow起動前に系列を記録する。DB保存に失敗したのにworkflowだけ走る
    // 「孤児dispatch」を作らない。既存系列のroundはリセットせず、手動再押下でも上限を維持する。
    // completed/stoppedは過去の系列なので、新しい手動開始ではラウンドをリセットする。
    // running/dispatchingの同一系列だけ上限を引き継ぐ。
    const existingState = await db.pullRequestAutoRepairLoop.findUnique({
      where: {
        repositoryFullName_pullRequestNumber: {
          repositoryFullName: `${owner}/${repo}`,
          pullRequestNumber: pullRequest.number,
        },
      },
      select: { round: true, status: true },
    });
    const continuing = existingState?.status === "running" || existingState?.status === "dispatching";
    if (continuing && existingState.round >= AUTO_REPAIR_MAX_ROUNDS) {
      return NextResponse.json(
        { error: "max_rounds_reached", message: "この自動修正系列は上限の3回に達しています。" },
        { status: 409 },
      );
    }
    const startingRound = continuing ? existingState.round + 1 : 1;
    await db.pullRequestAutoRepairLoop.upsert({
      where: {
        repositoryFullName_pullRequestNumber: {
          repositoryFullName: `${owner}/${repo}`,
          pullRequestNumber: pullRequest.number,
        },
      },
      create: {
        repositoryFullName: `${owner}/${repo}`,
        pullRequestNumber: pullRequest.number,
        status: "dispatching",
        headSha: pullRequest.head.sha,
        round: startingRound,
        currentKind: kind,
        lastFingerprint: `${pullRequest.head.sha}:${kind}`,
        lastSweepAt: null,
        waitStartedAt: null,
      },
      update: {
        status: "dispatching",
        headSha: pullRequest.head.sha,
        round: startingRound,
        currentKind: kind,
        lastFingerprint: `${pullRequest.head.sha}:${kind}`,
        stopReason: null,
        lastSweepAt: null,
        waitStartedAt: null,
      },
    });

    try {
      await dispatchWorkflow(owner, repo, dispatch.workflowFile, dispatch.ref, dispatch.inputs, token);
    } catch (error) {
      await db.pullRequestAutoRepairLoop.update({
        where: {
          repositoryFullName_pullRequestNumber: {
            repositoryFullName: `${owner}/${repo}`,
            pullRequestNumber: pullRequest.number,
          },
        },
        data: { status: "stopped", currentKind: null, stopReason: "dispatch_failed" },
      });
      throw error;
    }
    await db.pullRequestAutoRepairLoop.update({
      where: {
        repositoryFullName_pullRequestNumber: {
          repositoryFullName: `${owner}/${repo}`,
          pullRequestNumber: pullRequest.number,
        },
      },
      data: { status: "running" },
    });

    // 実際に起動した種類だけrunningとして記録する。未起動の修復が画面へ残らないようにする。
    await recordPullRequestRepairRun({
      repositoryFullName: `${owner}/${repo}`,
      pullRequestNumber: pullRequest.number,
      kind,
      status: "running",
    }).catch((error: unknown) => {
      console.warn(`[POST /api/pull-requests/repair] ${owner}/${repo}#${number} の記録:`, error);
    });

    // 以後はpollerが新HEADのCI・再レビューを待ち、必要なら次の1種類を起動する。

    return NextResponse.json({ ok: true, kinds: [kind], remainingKinds: kinds.slice(1), maxRounds: AUTO_REPAIR_MAX_ROUNDS });
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
