import { formatJstWeekday, toJstParts } from "@/lib/format-date-time";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import type { ConnectedRepository } from "@/types/repository";

/**
 * 全リポジトリ横断の「リリース履歴」画面（#2726）が扱うデータの組み立て。
 *
 * 元データは`fetchRecentReleases`（`lib/github/release-api.ts`）が返す、リポジトリ1件ぶんの
 * GitHub Release一覧。ここでは**複数リポジトリぶんを1本の時系列へ束ねる**ことだけを扱う。
 */

/**
 * 複数リポジトリぶんのリリース一覧を、公開日時の新しい順に1本へ束ねる。
 *
 * **公開時刻が取れないもの（`publishedAt`が`null`）は捨てる。** 時系列に置けない値を
 * 混ぜると、並び順の先頭・末尾どちらに出すべきか決められない（draftの取りこぼれ等、
 * 通常は起きない想定）。
 */
export function mergeReleaseHistory(
  perRepository: readonly (readonly ReleaseHistoryItem[])[],
): ReleaseHistoryItem[] {
  return perRepository
    .flat()
    .filter((entry): entry is ReleaseHistoryItem & { publishedAt: string } => entry.publishedAt !== null)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/**
 * 左メニューで非表示にしたリポジトリぶんを取り除く（#2279。`release-activity.ts`の
 * `selectVisibleReleaseStatuses`と同じ考え方）。**APIの母集団は絞らない**——「すべて表示する」
 * に切り替えたときのために、サーバー側では非表示リポジトリぶんも含めて返す。
 */
export function selectVisibleReleaseHistory(
  entries: readonly ReleaseHistoryItem[],
  repositories: readonly Pick<ConnectedRepository, "fullName" | "hidden">[],
): ReleaseHistoryItem[] {
  const hiddenFullNames = new Set(
    repositories.filter((repo) => repo.hidden).map((repo) => repo.fullName),
  );
  if (hiddenFullNames.size === 0) return [...entries];
  return entries.filter((entry) => !hiddenFullNames.has(entry.repoFullName));
}

const GENERATED_BULLET_LINE = /^\*\s+(.+?)\s+by\s+@\S+\s+in\s+\S+\s*$/;

/**
 * GitHubが自動生成したリリース本文（`generate_release_notes: true`）から、
 * 「マージ済みPRタイトルの箇条書き」だけを取り出す。
 *
 * 生の本文は`## What's Changed`の見出しと`**Full Changelog**: <compare URL>`を含み、
 * そのまま出すと「タイムラインで何がリリースされたか」を一目で追えない。**箇条書きの行
 * （`* タイトル by @user in owner/repo#123`）だけを拾い、`by @user in ...`を落として
 * タイトルだけに縮める。**
 *
 * `max`件を超えるぶんは`moreCount`に残す（画面側は「ほかN件」として出す）。
 */
export function extractReleaseHighlights(
  body: string | null,
  max = 3,
): { lines: string[]; moreCount: number } {
  if (!body) return { lines: [], moreCount: 0 };

  const bulletLines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("* "))
    .map((line) => {
      const match = GENERATED_BULLET_LINE.exec(line);
      return (match ? match[1] : line.slice(2)).trim();
    })
    .filter((line) => line.length > 0);

  return {
    lines: bulletLines.slice(0, max),
    moreCount: Math.max(0, bulletLines.length - max),
  };
}

/** 日付（日本時間）でグルーピングした1日ぶん */
export type ReleaseHistoryDateGroup = {
  /** `2026-09-02`。Reactのkeyにそのまま使える */
  dateKey: string;
  year: number;
  month: number;
  day: number;
  weekdayLabel: string;
  entries: ReleaseHistoryItem[];
};

/**
 * 日本時間の日付でグルーピングする。
 *
 * **入力は`mergeReleaseHistory`で公開日時の新しい順に並んでいる前提**——ここでは
 * 「直前と同じ日付かどうか」だけを見て新しい日付グループを起こすため、
 * 順不同の配列を渡すと同じ日が複数グループに割れる。
 */
export function groupReleaseHistoryByJstDate(
  entries: readonly ReleaseHistoryItem[],
): ReleaseHistoryDateGroup[] {
  const groups: ReleaseHistoryDateGroup[] = [];
  for (const entry of entries) {
    if (!entry.publishedAt) continue;
    const parts = toJstParts(entry.publishedAt);
    if (!parts) continue;
    const dateKey = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

    const current = groups.at(-1);
    if (current && current.dateKey === dateKey) {
      current.entries.push(entry);
      continue;
    }
    groups.push({
      dateKey,
      year: parts.year,
      month: parts.month,
      day: parts.day,
      weekdayLabel: formatJstWeekday(entry.publishedAt),
      entries: [entry],
    });
  }
  return groups;
}
