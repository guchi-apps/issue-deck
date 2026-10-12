import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  CLOSED_PAGED_PER_PAGE,
  fetchClosedPullRequestsForBasePage,
  type GithubApiOpenPullRequest,
} from "@/lib/github/pull-requests-api";
import {
  fetchOpenPullRequestsForBase,
  fetchPullMergeInfo,
  fetchTagRefs,
} from "@/lib/github/release-api";
import { IOS_TESTFLIGHT_TAG_PREFIX } from "@/lib/ios-testflight-status";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { redactDiagnosticText } from "@/lib/release-review-diagnostic";
import {
  buildRebuildEpisodes,
  decideCompletedThroughPr,
  isEpisodeCompleted,
  rebuildEventKey,
  REBUILD_EVENT_KINDS,
  REBUILD_EVENT_TRIGGERS,
  type RebuildEpisode,
  type RebuildEventKind,
  type RebuildEventPayload,
  type RebuildEventTrigger,
  type RebuildEventView,
} from "@/lib/release-rebuild-history";

/**
 * リリース候補の作り直しの操作履歴（#4359）の記録と取得。判断・文面は`release-rebuild-history.ts`の純関数が持つ。
 *
 * **記録は追記のみ。** 同じ依頼の重複（二重クリック・巡回の重なり・再起動後の再実行）は`dedupeKey`の
 * ユニーク制約で1件に絞る。**記録の失敗は本処理を止めない**（履歴は証跡であり、作り直しの前提にしない）。
 * 理由は機密除去してから保存し、トークンなどの秘密値は入れない。
 */

const FROZEN_PREFIX = "release-main/v";
const MAX_REASON = 2000;
const RECENT_DAYS = 30;
const DISPLAY_DAYS = 7;

export type RecordRebuildEventInput = {
  repositoryFullName: string;
  originPrNumber: number;
  originHeadSha: string;
  kind: Exclude<RebuildEventKind, "legacy_unknown">;
  actor: { kind: "user"; userId: string } | { kind: "system" };
  trigger: RebuildEventTrigger;
  reason?: string | null;
  seriesId?: string | null;
  payload?: RebuildEventPayload;
  dedupeKey: string;
};

/** イベントを1件記録する。同じ`dedupeKey`が既にあれば既存のidを返す（新しい行は増やさない） */
export async function recordRebuildEvent(input: RecordRebuildEventInput): Promise<string | null> {
  try {
    const row = await db.releaseRebuildEvent.create({
      data: {
        repositoryFullName: input.repositoryFullName,
        originPrNumber: input.originPrNumber,
        originHeadSha: input.originHeadSha,
        kind: input.kind,
        actorKind: input.actor.kind,
        actorUserId: input.actor.kind === "user" ? input.actor.userId : null,
        trigger: input.trigger,
        reason: input.reason ? redactDiagnosticText(input.reason).slice(0, MAX_REASON) : null,
        seriesId: input.seriesId ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        dedupeKey: input.dedupeKey,
      },
    });
    return row.id;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await db.releaseRebuildEvent
        .findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } })
        .catch(() => null);
      return existing?.id ?? null;
    }
    console.error("[release-rebuild-history] 記録に失敗しました", input.repositoryFullName, input.kind, error);
    return null;
  }
}

/** この元の候補に対する、承認済みで作り直しにまだ使われていない最新の承認イベント */
export async function findLatestApprovalEventId(
  repositoryFullName: string,
  originPrNumber: number,
  originHeadSha: string,
): Promise<string | null> {
  const row = await db.releaseRebuildEvent.findFirst({
    where: { repositoryFullName, originPrNumber, originHeadSha, kind: "approval" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

function asKind(value: string): RebuildEventKind {
  return (REBUILD_EVENT_KINDS as readonly string[]).includes(value) ? (value as RebuildEventKind) : "stopped";
}
function asTrigger(value: string): RebuildEventTrigger {
  return (REBUILD_EVENT_TRIGGERS as readonly string[]).includes(value) ? (value as RebuildEventTrigger) : "unknown";
}

/** 画面に出す履歴。DBだけを読む（PCのブランチ画面が追加のGitHub API取得をしない前提を守る） */
export async function listRebuildEpisodes(repositoryFullName: string, limit = 5): Promise<RebuildEpisode[]> {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  // 完了したリリースの経過は出さない（#4420）。境界は巡回が進める
  const cutoff = await db.releaseRebuildHistoryCutoff.findUnique({ where: { repositoryFullName } });
  const completedThrough = cutoff?.completedThroughPrNumber ?? null;
  const rows = await db.releaseRebuildEvent.findMany({
    where: { repositoryFullName, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((id): id is string => id !== null))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, githubLogin: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name?.trim() || u.githubLogin]));

  const views: (RebuildEventView & { originPrNumber: number; originHeadSha: string })[] = rows.map((row) => ({
    id: row.id,
    kind: asKind(row.kind),
    actorKind: row.actorKind === "user" ? "user" : "system",
    actorName: row.actorUserId ? (nameOf.get(row.actorUserId) ?? null) : null,
    trigger: asTrigger(row.trigger),
    reason: row.reason,
    seriesId: row.seriesId,
    payload: (row.payload ?? {}) as RebuildEventPayload,
    createdAt: row.createdAt.toISOString(),
    originPrNumber: row.originPrNumber,
    originHeadSha: row.originHeadSha,
  }));

  // 記録が入る前に作られた作り直し（修正系列に後継候補だけが残っている）は、経路不明として補う
  const covered = new Set(views.map((v) => `${v.originPrNumber}@${v.originHeadSha}`));
  const legacySeries = await db.releaseFixSeries.findMany({
    where: {
      repositoryFullName,
      updatedAt: { gte: since },
      OR: [{ successorPrNumber: { not: null } }, { status: "rebuilding" }],
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  for (const series of legacySeries) {
    const key = `${series.releasePrNumber}@${series.originHeadSha}`;
    if (covered.has(key)) continue;
    covered.add(key);
    views.push({
      id: `legacy-${series.id}`,
      kind: "legacy_unknown",
      actorKind: "unknown",
      actorName: null,
      trigger: "unknown",
      reason: "この作り直しの操作記録がありません。承認の有無・操作者は確認できません",
      seriesId: series.id,
      payload: series.successorPrNumber
        ? { successor: { number: series.successorPrNumber, headSha: series.successorHeadSha, baseSha: series.successorBaseSha } }
        : {},
      createdAt: series.updatedAt.toISOString(),
      originPrNumber: series.releasePrNumber,
      originHeadSha: series.originHeadSha,
    });
  }
  // 画面に出すのは直近の経過だけ（古い完了済みの履歴で盤面を埋めない）
  const shownSince = new Date(Date.now() - DISPLAY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return buildRebuildEpisodes(views)
    .filter((episode) => episode.updatedAt >= shownSince && !isEpisodeCompleted(episode, completedThrough))
    .slice(0, limit);
}

/**
 * 作り直しを開始したのに後継候補が未記録の経過について、今開いている凍結ブランチのリリースPRを後継として記録する。
 * 後継候補を作るのはリリースworkflowなので、準備の完了報告（`notify-prepared`）や巡回から呼ぶ。
 */
export async function observeRebuildSuccessor(input: {
  owner: string;
  repo: string;
  token: string;
}): Promise<number> {
  const repositoryFullName = `${input.owner}/${input.repo}`;
  const open = await fetchOpenPullRequestsForBase(input.owner, input.repo, "main", input.token);
  const frozen = open.find((pr) => pr.head.ref.startsWith(FROZEN_PREFIX));
  if (!frozen) return 0;
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const started = await db.releaseRebuildEvent.findMany({
    where: { repositoryFullName, kind: "rebuild_started", createdAt: { gte: since }, originPrNumber: { lt: frozen.number } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const done = await db.releaseRebuildEvent.findMany({
    where: { repositoryFullName, kind: "successor_created", createdAt: { gte: since } },
    select: { originPrNumber: true, originHeadSha: true },
  });
  const finished = new Set(done.map((e) => `${e.originPrNumber}@${e.originHeadSha}`));
  let recorded = 0;
  // 後継候補を作るのは直近の作り直しだけ。古い経過へ今の候補を結び付けない
  const pending = started.find((e) => !finished.has(`${e.originPrNumber}@${e.originHeadSha}`));
  for (const event of pending ? [pending] : []) {
    const id = await recordRebuildEvent({
      repositoryFullName,
      originPrNumber: event.originPrNumber,
      originHeadSha: event.originHeadSha,
      kind: "successor_created",
      actor: { kind: "system" },
      trigger: "workflow",
      payload: { successor: { number: frozen.number, headSha: frozen.head.sha, baseSha: frozen.base?.sha ?? null } },
      dedupeKey: rebuildEventKey.successor(repositoryFullName, event.originPrNumber, frozen.number),
    });
    if (id) recorded += 1;
  }
  return recorded;
}

/** 完了済みの経過のイベントを削除する。後継候補が境界を超えている（作成中）経過は残す */
export async function purgeCompletedRebuildEvents(repositoryFullName: string, completedThrough: number): Promise<number> {
  const candidates = await db.releaseRebuildEvent.findMany({
    where: { repositoryFullName, originPrNumber: { lte: completedThrough } },
    select: { id: true, originPrNumber: true, originHeadSha: true, kind: true, payload: true },
  });
  const keepKeys = new Set<string>();
  for (const event of candidates) {
    if (event.kind !== "successor_created") continue;
    const successor = (event.payload as RebuildEventPayload | null)?.successor;
    if (successor && successor.number > completedThrough) keepKeys.add(`${event.originPrNumber}@${event.originHeadSha}`);
  }
  const ids = candidates.filter((e) => !keepKeys.has(`${e.originPrNumber}@${e.originHeadSha}`)).map((e) => e.id);
  if (ids.length === 0) return 0;
  const { count } = await db.releaseRebuildEvent.deleteMany({ where: { id: { in: ids } } });
  return count;
}

/** 完了境界を探すときに遡るページ数の上限（1ページ100件） */
const MAX_CLOSED_PAGES = 10;

/**
 * main向けのclosed PRを番号の降順にページを進め、マージ済みのリリースPRを新しい順に集める（#4474）。
 *
 * 作り直しのたびに閉じたリリース候補がmain向けのclosed PRに積もるため、直近の1ページだけでは
 * 完了済みのリリースPRへ届かないことがある。`enough`件見つかるか、`floor`以下の番号に達するか
 * （それより古いリリースはどの履歴も完了にできない）、ページが尽きるまで遡る。
 */
export async function collectMergedReleasePrs(
  fetchPage: (page: number) => Promise<GithubApiOpenPullRequest[]>,
  options: { floor: number; enough: number; maxPages?: number },
): Promise<GithubApiOpenPullRequest[]> {
  const found: GithubApiOpenPullRequest[] = [];
  const maxPages = options.maxPages ?? MAX_CLOSED_PAGES;
  for (let page = 1; page <= maxPages; page += 1) {
    const prs = await fetchPage(page);
    for (const pr of prs) {
      if (pr.number <= options.floor) return found;
      if (pr.merged_at !== null && pr.head.ref.startsWith(FROZEN_PREFIX)) {
        found.push(pr);
        if (found.length >= options.enough) return found;
      }
    }
    if (prs.length < CLOSED_PAGED_PER_PAGE) break;
  }
  return found;
}

/**
 * 1リポジトリの履歴の完了を判定し、境界を進めて完了済みの履歴を削除する（#4420）。
 * 境界は後戻りさせない（一覧の取得範囲の都合で小さい番号が返っても、完了済みを復活させない）。
 */
export async function sweepCompletedRebuildHistory(repositoryFullName: string): Promise<{ completedThrough: number | null; deleted: number }> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  const current = await db.releaseRebuildHistoryCutoff.findUnique({ where: { repositoryFullName } });
  let completedThrough = current?.completedThroughPrNumber ?? null;
  if (repository) {
    const token = await getInstallationToken(repository.installation.installationId);
    const { ownerLogin: owner, name: repo } = repository;
    const requiresIosDelivery = getWebviewIosRepository(repositoryFullName) !== null;
    // 残っている履歴の最小の元候補番号より古いリリースは、どの経過も完了にできない
    const oldest = await db.releaseRebuildEvent.aggregate({
      where: { repositoryFullName, ...(completedThrough === null ? {} : { originPrNumber: { gt: completedThrough } }) },
      _min: { originPrNumber: true },
    });
    const merged = await collectMergedReleasePrs((page) => fetchClosedPullRequestsForBasePage(owner, repo, "main", token, page), {
      // floor「以下」は判定せず打ち切るので、最小の元候補PR自身も判定対象に残すよう1小さくする（#4488）
      floor: Math.max(completedThrough ?? 0, (oldest._min.originPrNumber ?? 1) - 1),
      // iOS配布を待つリポジトリは直近のマージが未配布でありうるので、数件まで遡る
      enough: requiresIosDelivery ? 5 : 1,
    });
    let mergedReleasePrs: { number: number; mergeSha: string | null }[];
    let deliveredShas = new Set<string>();
    if (requiresIosDelivery) {
      const tagRefs = await fetchTagRefs(owner, repo, token, IOS_TESTFLIGHT_TAG_PREFIX);
      deliveredShas = new Set(tagRefs.map((ref) => ref.sha).filter(Boolean));
      // マージコミットの取得は、境界より新しい直近の数件だけ（APIの消費を抑える）
      const fresh = merged.filter((pr) => completedThrough === null || pr.number > completedThrough).slice(0, 5);
      mergedReleasePrs = await Promise.all(
        fresh.map(async (pr) => ({
          number: pr.number,
          mergeSha: (await fetchPullMergeInfo(owner, repo, token, pr.number))?.mergeCommitSha ?? null,
        })),
      );
    } else {
      mergedReleasePrs = merged.map((pr) => ({ number: pr.number, mergeSha: null }));
    }
    const decided = decideCompletedThroughPr({ mergedReleasePrs, requiresIosDelivery, deliveredShas });
    if (decided !== null && (completedThrough === null || decided > completedThrough)) {
      completedThrough = decided;
      await db.releaseRebuildHistoryCutoff.upsert({
        where: { repositoryFullName },
        create: { repositoryFullName, completedThroughPrNumber: decided },
        update: { completedThroughPrNumber: decided },
      });
    }
  }
  const deleted = completedThrough === null ? 0 : await purgeCompletedRebuildEvents(repositoryFullName, completedThrough);
  return { completedThrough, deleted };
}

/** 履歴を持つ全リポジトリを巡回する。1リポジトリの失敗で他を止めない */
export async function sweepAllCompletedRebuildHistory(): Promise<{ repositories: number; deleted: number }> {
  const [eventRepos, seriesRepos] = await Promise.all([
    db.releaseRebuildEvent.findMany({ distinct: ["repositoryFullName"], select: { repositoryFullName: true } }),
    db.releaseFixSeries.findMany({
      where: { OR: [{ successorPrNumber: { not: null } }, { status: "rebuilding" }] },
      distinct: ["repositoryFullName"],
      select: { repositoryFullName: true },
    }),
  ]);
  const names = [...new Set([...eventRepos, ...seriesRepos].map((r) => r.repositoryFullName))];
  let deleted = 0;
  for (const name of names) {
    try {
      deleted += (await sweepCompletedRebuildHistory(name)).deleted;
    } catch (error) {
      console.error(`[release-rebuild-history] 完了済み履歴の掃除に失敗しました（${name}）`, error);
    }
  }
  return { repositories: names.length, deleted };
}
