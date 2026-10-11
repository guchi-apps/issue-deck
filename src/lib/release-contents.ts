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
      added: ReleaseChangePullRequest[];
      /** 記録にあるが、今回の差分に載っていないPRの番号 */
      excluded: number[];
      unknownCommits: ReleaseChangeCommit[];
      truncated: boolean;
    };

export function classifyReleaseContents(input: {
  changes: { pullRequests: readonly ReleaseChangePullRequest[]; unknownCommits: readonly ReleaseChangeCommit[]; truncated: boolean } | null;
  isLoading: boolean;
  error: string | null;
  /** 今回の修正で足したPR番号（作り直し記録の`selectedPrs`） */
  addedPrNumbers: readonly number[];
  /** 今回は含めないとしたPR番号（作り直し記録の`excludedPrs`） */
  excludedPrNumbers: readonly number[];
}): ReleaseContentsState {
  if (input.error) return { kind: "error", message: input.error };
  if (!input.changes) return { kind: "loading" };
  const added = new Set(input.addedPrNumbers);
  const visible = input.changes.pullRequests.filter((pr) => !pr.isVersionBump);
  const inDiff = new Set(input.changes.pullRequests.map((pr) => pr.number));
  return {
    kind: "ready",
    original: visible.filter((pr) => !added.has(pr.number)),
    added: visible.filter((pr) => added.has(pr.number)),
    excluded: [...new Set(input.excludedPrNumbers)].filter((n) => !inDiff.has(n)).sort((a, b) => a - b),
    unknownCommits: [...input.changes.unknownCommits],
    truncated: input.changes.truncated,
  };
}
