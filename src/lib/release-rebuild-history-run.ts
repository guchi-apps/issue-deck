import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { fetchOpenPullRequestsForBase } from "@/lib/github/release-api";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { redactDiagnosticText } from "@/lib/release-review-diagnostic";
import {
  buildRebuildEpisodes,
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
    .filter((episode) => episode.updatedAt >= shownSince)
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
