import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import type { ReleaseCheckLineRecord } from "@/lib/release-check";
import { mergeReleaseHistory } from "@/lib/release-history";

/**
 * リリース履歴を段階的に取る（#5230）ときの取得範囲。
 *
 * - `targets`: 動作確認の対象にしたリポジトリ（初期表示の「未確認のリリース」はここからしか出ない）
 * - `others`: それ以外（「確認済みも表示」で出るもの）
 * - `all`: 従来どおり全部（scopeを付けない呼び出し）
 */
export type ReleaseHistoryScope = "targets" | "others" | "all";

export function parseReleaseHistoryScope(value: string | null): ReleaseHistoryScope {
  return value === "targets" || value === "others" ? value : "all";
}

/** そのリポジトリがscopeの母集団に入るか */
export function isInReleaseHistoryScope(scope: ReleaseHistoryScope, isCheckTarget: boolean): boolean {
  if (scope === "all") return true;
  return scope === "targets" ? isCheckTarget : !isCheckTarget;
}

/**
 * 一覧の鮮度（#5230）。
 *
 * - `stale`: 前回の取得結果（キャッシュ）だけを出している。項目チェックは押させない
 * - `partial`: 確認対象のリポジトリは最新。それ以外はまだ前回の値か未取得
 * - `fresh`: すべて最新
 */
export type ReleaseHistoryFreshness = "stale" | "partial" | "fresh";

/** 1回の応答ぶん。`repositories`はこの応答が受け持ったリポジトリ（0件でも空配列で示す） */
export type ReleaseHistoryChunk = {
  repositories: readonly string[];
  entries: readonly ReleaseHistoryItem[];
  checkLineRecords: readonly ReleaseCheckLineRecord[];
};

export type ReleaseHistoryState = {
  entries: ReleaseHistoryItem[];
  checkLineRecords: ReleaseCheckLineRecord[];
};

/**
 * 応答が受け持ったリポジトリの分だけを差し替える（#5230）。
 *
 * キャッシュ→確認対象→その他の順に重ねるとき、後から届いた応答が他のリポジトリの
 * 値を消さないようにする。受け持ったリポジトリは、応答に1件も無ければ空になる
 * （リリースが消えた・取得範囲から外れた場合も前回の値を残さない）。
 * 取得に失敗したリポジトリはサーバーが`repositories`に含めないため、前回の値が残る。
 */
export function mergeReleaseHistoryByRepository(
  current: ReleaseHistoryState | null,
  chunk: ReleaseHistoryChunk,
): ReleaseHistoryState {
  const replaced = new Set(chunk.repositories);
  const keptEntries = (current?.entries ?? []).filter((entry) => !replaced.has(entry.repoFullName));
  const keptLines = (current?.checkLineRecords ?? []).filter((record) => !replaced.has(record.repoFullName));
  return {
    entries: mergeReleaseHistory([keptEntries, chunk.entries]),
    checkLineRecords: [...keptLines, ...chunk.checkLineRecords],
  };
}
