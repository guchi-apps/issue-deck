import { db } from "@/lib/db";
import {
  dispatchReleaseWorkflow,
  fetchPullRequestForRebuild,
  fetchRefCiState,
  fetchReleaseRebuildCandidate,
  isAncestorCommit,
  releaseCallerSupportsSelection,
  type CiState,
  type GithubApiPullRequest,
} from "@/lib/github/release-api";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { excludedFromSelection, rebuildEventKey, type RebuildEventTrigger } from "@/lib/release-rebuild-history";
import { recordRebuildEvent } from "@/lib/release-rebuild-history-run";
import {
  REBUILD_PR_PROBLEM_LABEL,
  checkRebuildPullRequest,
  defaultRebuildSelection,
  isRebuildRequestBlocking,
  orderSelection,
  rebuildRequestActiveKey,
  serializeRebuildSelection,
  type RebuildPullRequestProblem,
  type RebuildSelectionPullRequest,
} from "@/lib/release-rebuild-selection";
import type { BumpKind } from "@/lib/semver-bump";

/**
 * PRを選んだ作り直し（#4335）の外部操作。判断は`release-rebuild-selection.ts`の純関数が持つ。
 *
 * **画面の「修正を入れて作り直す」と修正系列（#4317）の自動作り直しは、どちらも`requestSelectiveRebuild`を通る。**
 * 元の候補（リリースPR）は閉じない——閉じるのは、workflowが後継のリリースPRを作れたとき。途中で失敗しても
 * 元の候補は開いたまま残り、失敗の記録に選択が残るので、リリース画面の「再開」から同じ選択でやり直せる。
 */

export type RebuildSelectionOption = {
  number: number;
  title: string;
  issueNumber: number | null;
  url: string | null;
  /** developへのマージコミット。未マージならnull */
  mergeSha: string | null;
  merged: boolean;
  /** developへのマージコミットのCI（取れなければ`unknown`）。未マージならnull */
  ciState: CiState | null;
  /** 当該リリースの修正系列の修正PRか */
  relatedFix: boolean;
  /** 選べない理由（選べるならnull） */
  problem: RebuildPullRequestProblem | null;
  problemLabel: string | null;
};

export type RebuildSelectionOptions = {
  /** このリポジトリのcallerが選んだ作り直しを受け付けるか（受け付けなければ従来の作り直しだけ） */
  supported: boolean;
  options: RebuildSelectionOption[];
  defaultSelected: number[];
  /** 進行中の依頼（同じ元の候補への作り直しを起動済み）。あれば押せない */
  inProgress: { createdAt: string; selection: RebuildSelectionPullRequest[] } | null;
};

async function relatedFixPullRequests(repositoryFullName: string, releasePrNumber: number) {
  const rows = await db.releaseFixSeries.findMany({
    where: { repositoryFullName, releasePrNumber, status: { notIn: ["stopped", "superseded"] } },
    select: { fixPrNumber: true },
  });
  return rows.map((row) => row.fixPrNumber).filter((n): n is number => n !== null);
}

async function findBlockingRequest(repositoryFullName: string, releasePr: GithubApiPullRequest) {
  const key = rebuildRequestActiveKey(repositoryFullName, releasePr.number, releasePr.head.sha);
  const row = await db.releaseRebuildRequest.findUnique({ where: { activeKey: key } });
  if (!row) return null;
  if (isRebuildRequestBlocking(row, new Date())) return row;
  // 結果を受け取れないまま期限を過ぎた依頼は失効させ、やり直せるようにする
  await db.releaseRebuildRequest.updateMany({ where: { id: row.id, activeKey: key }, data: { status: "expired", activeKey: null } });
  return null;
}

/** 確認ダイアログの材料。元の候補の後にdevelopへ入ったPRと、当該リリースの修正PR（未マージを含む） */
export async function loadRebuildSelectionOptions(input: {
  owner: string;
  repo: string;
  token: string;
  releasePr: GithubApiPullRequest;
}): Promise<RebuildSelectionOptions> {
  const { owner, repo, token, releasePr } = input;
  const repositoryFullName = `${owner}/${repo}`;
  const supported = await releaseCallerSupportsSelection(owner, repo, token);
  const candidate = await fetchReleaseRebuildCandidate(owner, repo, releasePr.head.sha, token);
  const related = await relatedFixPullRequests(repositoryFullName, releasePr.number);

  const options: RebuildSelectionOption[] = await Promise.all(
    candidate.pullRequests.map(async (pr) => ({
      number: pr.number,
      title: pr.title,
      issueNumber: pr.issueNumber,
      url: `https://github.com/${repositoryFullName}/pull/${pr.number}`,
      mergeSha: pr.mergeSha ?? null,
      merged: true,
      ciState: pr.mergeSha ? await fetchRefCiState(owner, repo, pr.mergeSha, token).catch(() => "unknown" as const) : null,
      relatedFix: related.includes(pr.number),
      problem: pr.mergeSha ? null : ("not_merged" as const),
      problemLabel: pr.mergeSha ? null : REBUILD_PR_PROBLEM_LABEL.not_merged,
    })),
  );

  // 修正系列の修正PRのうち、まだdevelopへ入っていないものも状態付きで並べる（選べない）
  for (const number of related) {
    if (options.some((option) => option.number === number)) continue;
    const pr = await fetchPullRequestForRebuild(owner, repo, number, token).catch(() => null);
    const check = checkRebuildPullRequest({
      number,
      pr: pr
        ? { title: pr.title, mergedAt: pr.merged_at, mergeSha: pr.merge_commit_sha, baseRef: pr.base.ref, headRef: pr.head.ref }
        : null,
      // 候補の一覧に無い＝元の候補の後にdevelopへ入っていない。マージ済みなら元の候補に含まれている
      includedInOrigin: pr?.merged_at != null,
    });
    const problem = check.ok ? null : check.problem;
    options.push({
      number,
      title: pr?.title ?? `#${number}`,
      issueNumber: pr ? Number(/^issue-(\d+)$/.exec(pr.head.ref)?.[1] ?? NaN) || null : null,
      url: pr?.html_url ?? null,
      mergeSha: pr?.merge_commit_sha ?? null,
      merged: pr?.merged_at != null,
      ciState: null,
      relatedFix: true,
      problem,
      problemLabel: problem ? REBUILD_PR_PROBLEM_LABEL[problem] : null,
    });
  }

  const blocking = await findBlockingRequest(repositoryFullName, releasePr);
  return {
    supported,
    options,
    defaultSelected: defaultRebuildSelection(
      options.filter((option) => option.problem === null).map((option) => option.number),
      related,
    ),
    inProgress: blocking
      ? { createdAt: blocking.createdAt.toISOString(), selection: (blocking.selection as RebuildSelectionPullRequest[]) ?? [] }
      : null,
  };
}

export type SelectiveRebuildResult =
  | { ok: true; requestId: string; selection: RebuildSelectionPullRequest[] }
  | { ok: false; error: "selection_unsupported" | "empty_selection" | "rebuild_in_progress" | "dispatch_failed" }
  | { ok: false; error: "invalid_selection"; problems: { number: number; problem: RebuildPullRequestProblem; label: string }[] };

/**
 * 選んだPRを検証し、元の候補へ足して作り直すworkflowを起動する。
 *
 * - **PR番号だけでなく、マージコミット・base・元の候補との関係を確かめる**（`checkRebuildPullRequest`）。
 *   `expected`（画面で選んだ時点のマージコミット）が今と違えば止める
 * - 同じ元の候補（番号＋head）への起動は`activeKey`で1本に絞る（画面の二重押し・修正系列との競合）
 * - 選択は広げない。依存PR・競合はworkflowが当てて確かめ、必要な追加範囲を示して止める
 */
export async function requestSelectiveRebuild(input: {
  owner: string;
  repo: string;
  token: string;
  releasePr: GithubApiPullRequest;
  selected: { number: number; expectedMergeSha?: string | null }[];
  bumpKind?: BumpKind;
  source: "manual" | "fix_series" | "resume";
  userId: string | null;
  /** 操作履歴（#4359）へ残す根拠。修正系列の自動作り直しが、関連修正のみか承認を契機にしたかを伝える */
  history?: { trigger: RebuildEventTrigger; seriesIds?: string[]; fixPrs?: number[]; approvalEventId?: string | null };
}): Promise<SelectiveRebuildResult> {
  const { owner, repo, token, releasePr } = input;
  const repositoryFullName = `${owner}/${repo}`;
  const numbers = [...new Map(input.selected.map((item) => [item.number, item])).values()];
  if (numbers.length === 0) return { ok: false, error: "empty_selection" };
  if (!(await releaseCallerSupportsSelection(owner, repo, token))) return { ok: false, error: "selection_unsupported" };

  const checked = await Promise.all(
    numbers.map(async ({ number, expectedMergeSha }) => {
      const pr = await fetchPullRequestForRebuild(owner, repo, number, token);
      const includedInOrigin = pr?.merge_commit_sha
        ? await isAncestorCommit(owner, repo, pr.merge_commit_sha, releasePr.head.sha, token)
        : false;
      const result = checkRebuildPullRequest(
        {
          number,
          pr: pr ? { title: pr.title, mergedAt: pr.merged_at, mergeSha: pr.merge_commit_sha, baseRef: pr.base.ref, headRef: pr.head.ref } : null,
          includedInOrigin,
        },
        expectedMergeSha,
      );
      return { number, mergedAt: pr?.merged_at ?? null, result };
    }),
  );
  const problems = checked.flatMap(({ number, result }) =>
    result.ok ? [] : [{ number, problem: result.problem, label: REBUILD_PR_PROBLEM_LABEL[result.problem] }],
  );
  if (problems.length > 0) return { ok: false, error: "invalid_selection", problems };

  const selection: RebuildSelectionPullRequest[] = orderSelection(checked).map(({ number, result }) => {
    if (!result.ok) throw new Error("unreachable");
    return { number, mergeSha: result.mergeSha, title: result.title };
  });

  if (await findBlockingRequest(repositoryFullName, releasePr)) return { ok: false, error: "rebuild_in_progress" };
  let request;
  try {
    request = await db.releaseRebuildRequest.create({
      data: {
        repositoryFullName,
        originPrNumber: releasePr.number,
        originHeadSha: releasePr.head.sha,
        selection,
        source: input.source,
        status: "dispatched",
        activeKey: rebuildRequestActiveKey(repositoryFullName, releasePr.number, releasePr.head.sha),
        requestedByUserId: input.userId,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { ok: false, error: "rebuild_in_progress" };
    throw error;
  }

  try {
    await dispatchReleaseWorkflow(
      owner,
      repo,
      token,
      input.bumpKind,
      false,
      serializeRebuildSelection({ origin: { pr: releasePr.number, headSha: releasePr.head.sha }, prs: selection }),
    );
  } catch (error) {
    console.error("[release-rebuild-selection] dispatch failed", repositoryFullName, error);
    await db.releaseRebuildRequest.update({
      where: { id: request.id },
      data: { status: "failed", activeKey: null, failureReason: "リリースworkflowを起動できませんでした" },
    });
    // 修正系列の自動作り直しは、巡回側が停止の記録を残す（同じ失敗を2件に増やさない）
    if (input.source !== "fix_series") {
      await recordRebuildEvent({
        repositoryFullName,
        originPrNumber: releasePr.number,
        originHeadSha: releasePr.head.sha,
        kind: "rebuild_failed",
        actor: actorOf(input.userId),
        trigger: historyTrigger(input),
        reason: "リリースworkflowを起動できませんでした",
        payload: { requestId: request.id, selectedPrs: selection },
        dedupeKey: rebuildEventKey.failed(repositoryFullName, releasePr.number, releasePr.head.sha, request.id),
      });
    }
    return { ok: false, error: "dispatch_failed" };
  }
  // 操作履歴（#4359）。元の候補の後にdevelopへ入ったPRのうち、今回足さないものも残す
  let developed: number[] = [];
  try {
    developed = (await fetchReleaseRebuildCandidate(owner, repo, releasePr.head.sha, token)).pullRequests.map((pr) => pr.number);
  } catch {
    // 含めないPRの一覧が取れなくても、起動した事実の記録は残す
  }
  await recordRebuildEvent({
    repositoryFullName,
    originPrNumber: releasePr.number,
    originHeadSha: releasePr.head.sha,
    kind: "rebuild_started",
    actor: actorOf(input.userId),
    trigger: historyTrigger(input),
    seriesId: input.history?.seriesIds?.[0] ?? null,
    payload: {
      mode: "selective",
      requestId: request.id,
      selectedPrs: selection,
      excludedPrs: excludedFromSelection(developed, selection.map((p) => p.number)),
      fixPrs: input.history?.fixPrs,
      approvalEventId: input.history?.approvalEventId ?? undefined,
    },
    dedupeKey: rebuildEventKey.start(repositoryFullName, releasePr.number, releasePr.head.sha, request.id),
  });
  return { ok: true, requestId: request.id, selection };
}

function actorOf(userId: string | null) {
  return userId ? ({ kind: "user", userId } as const) : ({ kind: "system" } as const);
}

function historyTrigger(input: { source: "manual" | "fix_series" | "resume"; history?: { trigger: RebuildEventTrigger } }): RebuildEventTrigger {
  if (input.history) return input.history.trigger;
  return input.source === "resume" ? "resume" : input.source === "fix_series" ? "fix_series_related" : "manual";
}

/** workflowが選んだ作り直しに失敗したと報告してきたときに、その依頼を終える（同じ元の候補へやり直せるように） */
export async function markRebuildRequestFailed(input: {
  repositoryFullName: string;
  originPrNumber: number;
  originHeadSha: string;
  reason: string | null;
}): Promise<void> {
  const key = rebuildRequestActiveKey(input.repositoryFullName, input.originPrNumber, input.originHeadSha);
  const active = await db.releaseRebuildRequest.findUnique({ where: { activeKey: key } });
  if (active) {
    await recordRebuildEvent({
      repositoryFullName: input.repositoryFullName,
      originPrNumber: input.originPrNumber,
      originHeadSha: input.originHeadSha,
      kind: "rebuild_failed",
      actor: { kind: "system" },
      trigger: "workflow",
      reason: input.reason ?? "リリースworkflowが作り直しに失敗しました",
      payload: { requestId: active.id, selectedPrs: Array.isArray(active.selection) ? (active.selection as { number: number; mergeSha: string; title: string }[]) : [] },
      dedupeKey: rebuildEventKey.failed(input.repositoryFullName, input.originPrNumber, input.originHeadSha, active.id),
    });
  }
  await db.releaseRebuildRequest.updateMany({
    where: { activeKey: key },
    data: { status: "failed", activeKey: null, failureReason: input.reason?.slice(0, 2000) ?? null },
  });
}
