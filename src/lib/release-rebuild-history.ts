/**
 * リリース候補の作り直しの操作履歴（#4359）。**純関数だけ**を置き、DB・GitHubへの操作は
 * `release-rebuild-history-run.ts`が持つ。
 *
 * 「自動で作り直しました」というコメントだけでは、手動の追加承認があったのか、関連修正だけで
 * 自動に進んだのかを区別できなかった。操作ごとに1件の記録（`ReleaseRebuildEvent`）を残し、
 * 画面は記録から「元候補・承認範囲・実際に取り込んだ範囲・含めなかった範囲・後継候補」を組み立てる。
 * **記録が無い履歴は「操作経路不明」と出し、ユーザーが承認したとは推測しない。**
 */

export const REBUILD_EVENT_KINDS = [
  "approval",
  "decision_waiting",
  "rebuild_started",
  "rebuild_failed",
  "successor_created",
  "stopped",
  "superseded",
  /** 記録が無い既存の履歴を画面で補う合成イベント（DBには入れない） */
  "legacy_unknown",
] as const;
export type RebuildEventKind = (typeof REBUILD_EVENT_KINDS)[number];

export const REBUILD_EVENT_TRIGGERS = [
  "manual",
  "resume",
  "fix_series_related",
  "fix_series_after_approval",
  "sweep",
  "workflow",
  "unknown",
] as const;
export type RebuildEventTrigger = (typeof REBUILD_EVENT_TRIGGERS)[number];

export type RebuildEventPullRequest = { number: number; mergeSha?: string | null; title?: string | null };

export type RebuildEventPayload = {
  /** `approval`: 承認した時点の範囲（後から入ったPRは含まない） */
  approvedPrs?: RebuildEventPullRequest[];
  /** `rebuild_started`: 元の候補へ足すと決めたPRと、適用時のマージコミット */
  selectedPrs?: RebuildEventPullRequest[];
  /** `rebuild_started`: その時点でdevelopにあったが、今回は含めないPR */
  excludedPrs?: number[];
  /** `decision_waiting`: 判断待ちの原因になったPR */
  pendingPrs?: number[];
  /** この作り直しの根拠になった修正PR */
  fixPrs?: number[];
  /** この作り直しの根拠にした承認イベント */
  approvalEventId?: string;
  /** `selective`＝選んだPRだけ足す / `full`＝従来のdevelop最新で作り直す */
  mode?: "selective" | "full";
  requestId?: string;
  successor?: { number: number; headSha: string | null; baseSha: string | null };
  runUrl?: string;
};

export type RebuildEventView = {
  id: string;
  kind: RebuildEventKind;
  actorKind: "user" | "system" | "unknown";
  /** 認証済みユーザーの表示名。システムや不明ならnull */
  actorName: string | null;
  trigger: RebuildEventTrigger;
  reason: string | null;
  seriesId: string | null;
  payload: RebuildEventPayload;
  createdAt: string;
};

export const REBUILD_EVENT_LABEL: Record<RebuildEventKind, string> = {
  approval: "追加PRの承認",
  decision_waiting: "判断待ち",
  rebuild_started: "作り直しを開始",
  rebuild_failed: "作り直しの失敗",
  successor_created: "後継候補を作成",
  stopped: "停止",
  superseded: "元候補の取消・置換",
  legacy_unknown: "操作経路不明",
};

export const REBUILD_TRIGGER_LABEL: Record<RebuildEventTrigger, string> = {
  manual: "画面の操作",
  resume: "失敗からの再開",
  fix_series_related: "関連修正のみの自動作り直し",
  fix_series_after_approval: "手動承認を契機にした自動作り直し",
  sweep: "巡回の観測",
  workflow: "リリースworkflowの報告",
  unknown: "不明",
};

export function describeRebuildActor(event: Pick<RebuildEventView, "actorKind" | "actorName">): string {
  if (event.actorKind === "user") return event.actorName ? `${event.actorName}（ユーザー）` : "ユーザー";
  if (event.actorKind === "system") return "システム（自動）";
  return "不明";
}

export type RebuildPhase =
  | "approved"
  | "awaiting_decision"
  | "preparing"
  | "failed"
  | "successor_created"
  | "superseded"
  | "unknown";

export const REBUILD_PHASE_LABEL: Record<RebuildPhase, string> = {
  approved: "承認済み・作り直しの開始待ち",
  awaiting_decision: "判断待ち",
  preparing: "後継候補を準備中",
  failed: "失敗・停止（再開できます）",
  successor_created: "後継候補を作成済み",
  superseded: "元候補が取消・置換されました",
  unknown: "操作経路不明",
};

export type RebuildEpisode = {
  key: string;
  originPrNumber: number;
  originHeadSha: string;
  startedAt: string;
  updatedAt: string;
  phase: RebuildPhase;
  phaseLabel: string;
  /** 承認ごとの範囲（承認した時点のもの。新しい順ではなく発生順） */
  approvals: RebuildEventView[];
  /** 直近の作り直しで元の候補へ足したPR */
  selectedPrs: RebuildEventPullRequest[];
  /** 直近の作り直しで含めなかったPR（承認後に入ったPRも、承認しない限りここに残る） */
  excludedPrs: number[];
  pendingPrs: number[];
  successor: { number: number; headSha: string | null; baseSha: string | null } | null;
  /** 記録の無い履歴。承認や操作者を推測しない */
  pathUnknown: boolean;
  events: RebuildEventView[];
};

const SHA_SHORT = 7;
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, SHA_SHORT) : "-";
}

function derivePhase(events: readonly RebuildEventView[]): RebuildPhase {
  const last = events[events.length - 1];
  if (!last) return "unknown";
  switch (last.kind) {
    case "successor_created":
      return "successor_created";
    case "rebuild_started":
      return "preparing";
    case "rebuild_failed":
    case "stopped":
      return "failed";
    case "decision_waiting":
      return "awaiting_decision";
    case "approval":
      return "approved";
    case "superseded":
      return "superseded";
    case "legacy_unknown":
      return "unknown";
  }
}

/**
 * 記録を「元の候補（番号＋head）」ごとの経過にまとめる。新しい経過が先頭。
 * 並びはcreatedAtの昇順を前提にせず、ここで整える（同時刻はid順で安定させる）。
 */
export function buildRebuildEpisodes(
  events: readonly (RebuildEventView & { originPrNumber: number; originHeadSha: string })[],
): RebuildEpisode[] {
  const groups = new Map<string, (RebuildEventView & { originPrNumber: number; originHeadSha: string })[]>();
  for (const event of events) {
    const key = `${event.originPrNumber}@${event.originHeadSha}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const episodes: RebuildEpisode[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const started = [...sorted].reverse().find((e) => e.kind === "rebuild_started");
    const waiting = [...sorted].reverse().find((e) => e.kind === "decision_waiting");
    const successorEvent = [...sorted].reverse().find((e) => e.kind === "successor_created");
    const phase = derivePhase(sorted);
    const hasStart = sorted.some((e) => e.kind === "rebuild_started");
    const onlyLegacy = sorted.every((e) => e.kind === "legacy_unknown");
    // 後継候補だけが記録され、誰がどの範囲で作り直したかの記録が無い＝経路不明（承認を推測しない）
    const pathUnknown = onlyLegacy || (!!successorEvent && !hasStart);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    episodes.push({
      key,
      originPrNumber: first.originPrNumber,
      originHeadSha: first.originHeadSha,
      startedAt: first.createdAt,
      updatedAt: last.createdAt,
      phase: pathUnknown && phase !== "successor_created" && phase !== "superseded" ? "unknown" : phase,
      phaseLabel:
        pathUnknown && phase !== "successor_created" && phase !== "superseded"
          ? REBUILD_PHASE_LABEL.unknown
          : REBUILD_PHASE_LABEL[phase],
      approvals: sorted.filter((e) => e.kind === "approval"),
      selectedPrs: started?.payload.selectedPrs ?? [],
      excludedPrs: started?.payload.excludedPrs ?? [],
      pendingPrs: waiting?.payload.pendingPrs ?? [],
      successor: successorEvent?.payload.successor ?? null,
      pathUnknown,
      events: sorted,
    });
  }
  return episodes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 作り直し開始イベントの契機。承認が根拠にあれば「承認を契機にした自動」、無ければ「関連修正のみ」 */
export function decideAutoRebuildTrigger(input: {
  approvalEventId: string | null;
}): "fix_series_after_approval" | "fix_series_related" {
  return input.approvalEventId ? "fix_series_after_approval" : "fix_series_related";
}

/** 元の候補の後にdevelopへ入ったPRのうち、今回足さないもの */
export function excludedFromSelection(developPrs: readonly number[], selected: readonly number[]): number[] {
  const chosen = new Set(selected);
  return [...new Set(developPrs)].filter((n) => !chosen.has(n)).sort((a, b) => a - b);
}

/** 承認範囲に含まれないPR（承認後に入ったPRを承認済みにしない） */
export function unapprovedPrs(developPrs: readonly number[], approvedPrs: readonly number[]): number[] {
  return excludedFromSelection(developPrs, approvedPrs);
}

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 重複イベントを1件に絞る鍵。同じ依頼・同じ範囲・同じ理由なら同じ鍵になる */
export const rebuildEventKey = {
  approval: (repo: string, pr: number, headSha: string, approved: readonly number[], seriesIds: readonly string[]) =>
    `approval:${repo}#${pr}@${headSha}:${[...approved].sort((a, b) => a - b).join(",")}:${[...seriesIds].sort().join(",")}`,
  start: (repo: string, pr: number, headSha: string, requestId: string) => `start:${repo}#${pr}@${headSha}:${requestId}`,
  startFull: (repo: string, pr: number, headSha: string, seriesIds: readonly string[]) =>
    `start-full:${repo}#${pr}@${headSha}:${[...seriesIds].sort().join(",")}`,
  failed: (repo: string, pr: number, headSha: string, requestId: string) => `failed:${repo}#${pr}@${headSha}:${requestId}`,
  stop: (seriesId: string, kind: string, reason: string) => `${kind}:${seriesId}:${hashText(reason)}`,
  successor: (repo: string, originPr: number, successorPr: number) => `successor:${repo}#${originPr}->${successorPr}`,
};
