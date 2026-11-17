import type { ReleaseChangeCommit, ReleaseChangePullRequest } from "@/types/pull-request";

/**
 * 「今回リリースする変更」の分類（#4398）。取得や差分の畳み込みは持たない薄い層で、
 * 入力は既存の`/api/repositories/release/changes?pullRequest=`の応答（リリースPR自身の実際の差分）と、
 * 作り直しの記録（`release-rebuild-history.ts`の`selectedPrs`・`excludedPrs`）だけ。
 *
 * - 差分に載っているPRだけを「元から含む」「今回の修正で追加」に分ける。**develop全体のPRは推測で足さない**
 * - 記録で「含めない」としたPRが差分に載っていなければ「含めない変更」に出す。載っていれば含める側が正
 * - 取得中・失敗は変更なしと扱わない。打ち切り・PR不明は明示する
 */

export type ReleaseContentsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      /** バンプPRは利用者から見た変更ではないため一覧から除く */
      original: ReleaseChangePullRequest[];
      /** `importedRevision`は新方式の候補へ取り込んだrevision（#5469）。旧方式の作り直しで足したPRはundefined */
      added: (ReleaseChangePullRequest & { importedRevision?: number })[];
      /** 前のリリースでmainへ取り込み済み（cherry-pick）のため一覧から外したPR番号（#5469） */
      releasedByPick: number[];
      /** 記録にあるが、今回の差分に載っていないPRの番号 */
      excluded: number[];
      unknownCommits: ReleaseChangeCommit[];
      truncated: boolean;
    };

export function classifyReleaseContents(input: {
  changes: {
    pullRequests: readonly ReleaseChangePullRequest[];
    unknownCommits: readonly ReleaseChangeCommit[];
    truncated: boolean;
    releasedByPick?: readonly number[];
  } | null;
  isLoading: boolean;
  error: string | null;
  /** 今回の修正で足したPR番号（作り直し記録の`selectedPrs`） */
  addedPrNumbers: readonly number[];
  /** 今回は含めないとしたPR番号（作り直し記録の`excludedPrs`） */
  excludedPrNumbers: readonly number[];
  /**
   * 新方式の候補の適用済みrevisionで取り込んだPR（#5469）。取り込みは`cherry-pick -m 1`で候補へ足すので、
   * 差分に載っていても「元から含む」ではなく取り込みで足したものとして分ける
   */
  importedPrs?: readonly { number: number; revision: number }[];
}): ReleaseContentsState {
  if (input.error) return { kind: "error", message: input.error };
  if (!input.changes) return { kind: "loading" };
  const importedAt = new Map<number, number>();
  for (const pr of input.importedPrs ?? []) if (!importedAt.has(pr.number)) importedAt.set(pr.number, pr.revision);
  const added = new Set([...input.addedPrNumbers, ...importedAt.keys()]);
  const visible = input.changes.pullRequests.filter((pr) => !pr.isVersionBump);
  const inDiff = new Set(input.changes.pullRequests.map((pr) => pr.number));
  return {
    kind: "ready",
    original: visible.filter((pr) => !added.has(pr.number)),
    added: visible
      .filter((pr) => added.has(pr.number))
      .map((pr) => (importedAt.has(pr.number) ? { ...pr, importedRevision: importedAt.get(pr.number) } : pr)),
    releasedByPick: [...new Set(input.changes.releasedByPick ?? [])].filter((n) => !inDiff.has(n)).sort((a, b) => a - b),
    excluded: [...new Set(input.excludedPrNumbers)].filter((n) => !inDiff.has(n)).sort((a, b) => a - b),
    unknownCommits: [...input.changes.unknownCommits],
    truncated: input.changes.truncated,
  };
}

/**
 * 適用済みrevisionで候補へ取り込んだPR番号→revision（#5469）。取り込みは`cherry-pick -m 1`のため、
 * developの元のマージは候補の祖先にならず、祖先関係だけでは「未取り込み」に見える。記録で補う。
 * 同じPRが複数のrevisionに載っていれば最初のもの
 */
export function importedRevisionByPr(revisions: readonly { revision: number; status: string; importedPrs: unknown }[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const revision of [...revisions].sort((a, b) => a.revision - b.revision)) {
    if (revision.status !== "applied" || !Array.isArray(revision.importedPrs)) continue;
    for (const pr of revision.importedPrs as { number?: unknown }[]) {
      if (typeof pr?.number === "number" && !result.has(pr.number)) result.set(pr.number, revision.revision);
    }
  }
  return result;
}
