/**
 * 「修正を入れて作り直す」で、元の候補へ足すPRを選ぶ（#4335）。**純関数だけ**を置き、GitHub・DBへの
 * 操作は`release-rebuild-selection-run.ts`が持つ。
 *
 * 以前の作り直しは元の候補を閉じてdevelopの最新でバンプし直していたため、元の候補の後にdevelopへ
 * 入った**無関係な変更**まで混ざった。選んで作り直すと、元の候補のheadへ選んだPRのマージ差分だけを
 * 当てた状態からバンプする（`reusable-release-develop-to-main.yml`の`rebuild-selection`）。
 *
 * 画面の手動選択と修正系列（#4317）の自動作り直しは、どちらもここの検証と`requestSelectiveRebuild`を通る。
 */

export type RebuildSelectionPullRequest = { number: number; mergeSha: string; title: string };

export type RebuildSelection = {
  origin: { pr: number; headSha: string };
  prs: RebuildSelectionPullRequest[];
};

const SHA = /^[0-9a-f]{40}$/;

/** workflowへ渡すJSON。**workflowが読むのは`origin`と`prs[].number`・`prs[].mergeSha`だけ** */
export function serializeRebuildSelection(selection: RebuildSelection): string {
  return JSON.stringify({
    origin: { pr: selection.origin.pr, headSha: selection.origin.headSha },
    prs: selection.prs.map((pr) => ({ number: pr.number, mergeSha: pr.mergeSha })),
  });
}

/** 失敗の記録などに残った指定を読み直す。形が崩れていればnull */
export function parseRebuildSelection(text: string | null | undefined): RebuildSelection | null {
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const value = data as { origin?: { pr?: unknown; headSha?: unknown }; prs?: unknown };
  const pr = value.origin?.pr;
  const headSha = value.origin?.headSha;
  if (!Number.isInteger(pr) || typeof headSha !== "string" || !SHA.test(headSha) || !Array.isArray(value.prs)) return null;
  const prs: RebuildSelectionPullRequest[] = [];
  for (const item of value.prs as { number?: unknown; mergeSha?: unknown; title?: unknown }[]) {
    if (!Number.isInteger(item?.number) || typeof item?.mergeSha !== "string" || !SHA.test(item.mergeSha)) return null;
    prs.push({ number: item.number as number, mergeSha: item.mergeSha, title: typeof item.title === "string" ? item.title : "" });
  }
  if (prs.length === 0) return null;
  return { origin: { pr: pr as number, headSha }, prs };
}

/** 選べないPRの理由。画面と受け口で同じ文言を使う */
export type RebuildPullRequestProblem =
  | "not_found"
  | "not_merged"
  | "not_develop"
  | "release_branch"
  | "already_included"
  | "sha_changed";

export const REBUILD_PR_PROBLEM_LABEL: Record<RebuildPullRequestProblem, string> = {
  not_found: "PRが見つかりません",
  not_merged: "developへ未マージです。developへのレビュー・マージ（従来どおりの自動レビュー）が済むと選べます",
  not_develop: "develop向けのPRではありません",
  release_branch: "バンプPR・リリースPRは選べません",
  already_included: "元の候補に既に含まれています",
  sha_changed: "選んだ後にPRのマージコミットが変わりました。選び直してください",
};

export type RebuildPullRequestFacts = {
  number: number;
  /** PRが取れなければnull */
  pr: {
    title: string;
    mergedAt: string | null;
    mergeSha: string | null;
    baseRef: string;
    headRef: string;
  } | null;
  /** マージコミットが元の候補のheadの祖先か（＝既に候補に入っている） */
  includedInOrigin: boolean;
};

/** 1件のPRを、元の候補へ足せるかで判定する。`expectedMergeSha`は画面で選んだ時点のマージコミット */
export function checkRebuildPullRequest(
  facts: RebuildPullRequestFacts,
  expectedMergeSha?: string | null,
): { ok: true; mergeSha: string; title: string } | { ok: false; problem: RebuildPullRequestProblem } {
  const pr = facts.pr;
  if (!pr) return { ok: false, problem: "not_found" };
  if (pr.headRef.startsWith("release/v") || pr.headRef.startsWith("release-main/v")) return { ok: false, problem: "release_branch" };
  if (pr.baseRef !== "develop") return { ok: false, problem: "not_develop" };
  if (!pr.mergedAt || !pr.mergeSha) return { ok: false, problem: "not_merged" };
  if (expectedMergeSha && expectedMergeSha !== pr.mergeSha) return { ok: false, problem: "sha_changed" };
  if (facts.includedInOrigin) return { ok: false, problem: "already_included" };
  return { ok: true, mergeSha: pr.mergeSha, title: pr.title };
}

/**
 * 既定の選択。**当該リリースに関連付いた修正PR（修正系列の修正PR）だけ**で、無関係なPRは選ばない。
 * 候補（元の候補の後にdevelopへ入ったPR）に無いもの（未マージ）は選べないので入れない。
 */
export function defaultRebuildSelection(candidates: readonly number[], relatedFixPrs: readonly number[]): number[] {
  const related = new Set(relatedFixPrs);
  return candidates.filter((n) => related.has(n));
}

/** 同じ元の候補への作り直しを1本に絞る鍵 */
export function rebuildRequestActiveKey(repositoryFullName: string, originPrNumber: number, originHeadSha: string): string {
  return `${repositoryFullName}#${originPrNumber}@${originHeadSha}`;
}

/** 起動した依頼が、workflowの結果を受け取れないまま残ったときに失効させるまでの時間 */
export const REBUILD_REQUEST_TTL_MS = 2 * 60 * 60 * 1000;

/** 進行中の依頼が今も二重起動を止めるべきものか */
export function isRebuildRequestBlocking(request: { status: string; createdAt: Date }, now: Date): boolean {
  return request.status === "dispatched" && now.getTime() - request.createdAt.getTime() < REBUILD_REQUEST_TTL_MS;
}

/** developへ入った順（マージ時刻）に並べる。workflowも本流の位置で並べ直すが、表示と記録を揃える */
export function orderSelection<T extends { mergedAt: string | null; number: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || a.number - b.number);
}
