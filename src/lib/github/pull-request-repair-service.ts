import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { startPullRequestAutoRepairLoop } from "@/lib/github/pull-request-auto-repair-start";
import {
  canRepairFromDeck,
  repairKindsFor,
  type RepairKind,
} from "@/lib/github/pull-request-repair";
import { AUTO_REPAIR_MAX_ROUNDS } from "@/lib/github/pull-request-repair-loop";
import {
  fetchActivePullRequestRepairRun,
  isRepairSymptomGone,
} from "@/lib/github/pull-request-repair-run";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { fetchPullRequestCiState } from "@/lib/github/release-api";

/**
 * 「PRを自動修正」の本体（#1293・#3975）。
 *
 * 画面のボタン（`POST /api/pull-requests/repair`）とIssueDeck Chatの確認カードが同じ関数を
 * 呼ぶ。Chat専用の複製を作らないための切り出しで、HTTPへの写し方だけが呼び出し元に残る。
 *
 * **起動先の判定はサーバー側で行う。** クライアントが持つ`PullRequestSummary`にもbase/headは
 * あるが、それを信用すると「Issue用のワークフローへ無関係なIssue番号を渡す」といった呼び方が
 * 成立してしまう。PRを取り直して実際のbase/head・open状態から決める。
 */

export type PullRequestRepairFailure = {
  ok: false;
  status: 404 | 409 | 502;
  error:
    | "not_found"
    | "not_repairable"
    | "repair_in_progress"
    | "workflow_not_found"
    | "github_api_error";
  message?: string;
};

export type PullRequestRepairStarted = {
  ok: true;
  kinds: RepairKind[];
  remainingKinds: RepairKind[];
  maxRounds: number;
};

export type PullRequestRepairPlan = {
  ok: true;
  /** 実行時に先頭から起動する順（conflict → ci → review） */
  kinds: RepairKind[];
};

export async function findRepositoryForUser(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

type Repository = NonNullable<Awaited<ReturnType<typeof findRepositoryForUser>>>;

type Evaluation =
  | { failure: PullRequestRepairFailure }
  | {
      failure?: undefined;
      token: string;
      pullRequest: Awaited<ReturnType<typeof fetchPullRequest>>;
      kinds: RepairKind[];
    };

async function evaluate(
  repository: Repository,
  owner: string,
  repo: string,
  number: number,
): Promise<Evaluation> {
  const token = await getInstallationToken(repository.installation.installationId);
  const pullRequest = await fetchPullRequest(owner, repo, number, token);
  const currentState = await fetchPullRequestCiState(owner, repo, number, token);
  const state = pullRequest.state === "closed" ? "closed" : "open";

  if (!canRepairFromDeck({ state, draft: pullRequest.draft })) {
    return {
      failure: {
        ok: false,
        status: 409,
        error: "not_repairable",
        message: "クローズ済み・ドラフトのPull Requestは自動修復の対象外です。",
      } satisfies PullRequestRepairFailure,
    };
  }

  const activeRepair = await fetchActivePullRequestRepairRun(`${owner}/${repo}`, pullRequest.number);
  // 終了報告が届かない旧workflowではDBにrunningが残ることがある。画面表示と同じく、
  // 現在のPR状態で元の症状が既に解消していれば、その古い記録で次の修復を止めない。
  const activeRepairStillRelevant =
    activeRepair !== null &&
    !isRepairSymptomGone(activeRepair.kind, {
      mergeable: currentState.mergeable,
      ciState: currentState.ciState,
    });
  if (activeRepairStillRelevant) {
    return {
      failure: {
        ok: false,
        status: 409,
        error: "repair_in_progress",
        message: "このPRは現在自動修正中です。完了してからもう一度実行してください。",
      } satisfies PullRequestRepairFailure,
    };
  }

  // 画面に表示した時点の状態を信用せず、実行時のHEADから対象を組み立て直す。
  // これによりCIとレビューが同時にNGでも、利用者が実行順を選ぶ必要がない。
  const kinds = repairKindsFor(
    {
      state,
      draft: pullRequest.draft,
      ciState: currentState.ciState,
      baseRef: pullRequest.base.ref,
      headRef: pullRequest.head.ref,
      reviewVerdict: parsePullRequestReviewVerdict(pullRequest.body),
    },
    currentState.mergeable,
  );
  if (kinds.length === 0) {
    return {
      failure: {
        ok: false,
        status: 409,
        error: "not_repairable",
        message: "このPRには現在、自動修正できる問題が見つかりませんでした。",
      } satisfies PullRequestRepairFailure,
    };
  }
  return { token, pullRequest, kinds };
}

function toFailure(error: unknown): PullRequestRepairFailure {
  // ワークフロー自体が無いリポジトリ・デフォルトブランチへ未反映の場合は404が返る。
  // 「押しても起動しない」理由が分かるよう、汎用のAPIエラーと区別して文言を返す。
  if (error instanceof GithubApiError && error.status === 404) {
    return {
      ok: false,
      status: 404,
      error: "workflow_not_found",
      message:
        "自動修復のworkflowがこのリポジトリで見つかりませんでした（デフォルトブランチへ未反映の可能性があります）。",
    };
  }
  return {
    ok: false,
    status: 502,
    error: "github_api_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** 実行はせず、いま起動したらどの種類が走るかだけを返す（Chatの確認カード用） */
export async function planPullRequestRepair(
  repository: Repository,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestRepairPlan | PullRequestRepairFailure> {
  try {
    const result = await evaluate(repository, owner, repo, number);
    if (result.failure) return result.failure;
    return { ok: true, kinds: result.kinds };
  } catch (error) {
    return toFailure(error);
  }
}

export async function startPullRequestRepair(
  repository: Repository,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestRepairStarted | PullRequestRepairFailure> {
  try {
    const result = await evaluate(repository, owner, repo, number);
    if (result.failure) return result.failure;
    const { token, pullRequest, kinds } = result;
    // 同じIssueブランチの修復workflowは同一concurrency groupを共有する。GitHub Actionsは
    // running 1件 + pending 1件しか保持しないため複数を一度にdispatchせず、優先順位
    // conflict → ci → review（repairKindsForの順）の先頭だけを起動する。完了後にPRを再取得し、
    // まだ問題が残っていれば同じ「PRを自動修正」から次を実行する。
    const kind = kinds[0];
    const started = await startPullRequestAutoRepairLoop({
      owner,
      repo,
      token,
      pullRequest: {
        number: pullRequest.number,
        headSha: pullRequest.head.sha,
        baseRef: pullRequest.base.ref,
        headRef: pullRequest.head.ref,
      },
      kind,
    });
    if (!started.ok) {
      return {
        ok: false,
        status: 409,
        error: "repair_in_progress",
        message: "このPRは現在自動修正中です。完了または停止してからもう一度実行してください。",
      };
    }
    return {
      ok: true,
      kinds: [kind],
      remainingKinds: kinds.slice(1),
      maxRounds: AUTO_REPAIR_MAX_ROUNDS,
    };
  } catch (error) {
    console.error(`[pull-request-repair] ${owner}/${repo}#${number}:`, error);
    return toFailure(error);
  }
}
