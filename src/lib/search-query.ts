import type { Issue, IssueState } from "@/types/issue";

export type ParsedSearchQuery = {
  /** AND条件。すべてのラベルを持つ必要がある（label:トークン） */
  includeLabels: string[];
  /** AND条件。いずれのラベルも持ってはいけない（-label:トークン） */
  excludeLabels: string[];
  /** is:トークン（最後に指定されたものを採用） */
  state: IssueState | null;
  /** assignee:トークン（"none"は未担当、それ以外はログイン名） */
  assignee: string | "none" | null;
  /** トークン除去後に残った自由語（部分一致でtitle/bodyに対して判定） */
  keyword: string;
};

// label:"in progress" / label:bug のように、値はダブルクォートで囲むかベアワードで書ける
const TOKEN_PATTERN = /(-?label|is|assignee):(?:"([^"]*)"|(\S+))/gi;

export function parseSearchQuery(q: string): ParsedSearchQuery {
  const includeLabels: string[] = [];
  const excludeLabels: string[] = [];
  let state: IssueState | null = null;
  let assignee: string | "none" | null = null;

  const keyword = q
    .replace(TOKEN_PATTERN, (match, rawKey: string, quoted: string | undefined, bare: string | undefined) => {
      const key = rawKey.toLowerCase();
      const value = quoted ?? bare ?? "";
      if (!value) return "";

      if (key === "label") {
        includeLabels.push(value);
      } else if (key === "-label") {
        excludeLabels.push(value);
      } else if (key === "is") {
        const normalized = value.toLowerCase();
        if (normalized === "open" || normalized === "closed") state = normalized;
      } else if (key === "assignee") {
        assignee = value.toLowerCase() === "none" ? "none" : value;
      }
      return "";
    })
    .trim()
    .toLowerCase();

  return { includeLabels, excludeLabels, state, assignee, keyword };
}

/**
 * 検索式のうち、`label:`・`is:`・`assignee:`のトークンだけを取り出して連結する（#1788）。
 *
 * AIあいまい検索の候補を集めるときに使う。候補は「自由語以外の条件を満たすIssue」——
 * 自由語で先に文字列一致の絞り込みをかけてしまうと、そもそもAIに探させたいIssueが
 * 候補から落ちる（0件のときにAIボタンを押すのが主な使い方のため、候補も0件になる）。
 */
export function extractSearchTokens(q: string): string {
  return (q.match(TOKEN_PATTERN) ?? []).join(" ");
}

export type MatchesSearchQueryOptions = {
  /**
   * AIあいまい検索で選ばれたIssueのid集合（#1788）。
   *
   * 渡されている間は、自由語の部分一致の代わりにこの集合への所属で判定する。
   * `label:`等のトークンは自由語と別に評価しているため、AI検索中もそのまま効く。
   */
  aiMatchedIds?: ReadonlySet<string> | null;
};

export function matchesSearchQuery(
  issue: Issue,
  q: string,
  options?: MatchesSearchQueryOptions,
): boolean {
  const parsed = parseSearchQuery(q);

  if (parsed.includeLabels.length > 0) {
    const issueLabelNames = new Set(issue.labels.map((label) => label.name));
    if (!parsed.includeLabels.every((name) => issueLabelNames.has(name))) return false;
  }

  if (parsed.excludeLabels.length > 0) {
    const issueLabelNames = new Set(issue.labels.map((label) => label.name));
    if (parsed.excludeLabels.some((name) => issueLabelNames.has(name))) return false;
  }

  if (parsed.state && issue.state !== parsed.state) return false;

  if (parsed.assignee) {
    if (parsed.assignee === "none") {
      if (issue.assignee) return false;
    } else if (issue.assignee?.login !== parsed.assignee) {
      return false;
    }
  }

  if (options?.aiMatchedIds) {
    if (!options.aiMatchedIds.has(issue.id)) return false;
  } else if (parsed.keyword) {
    const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
    if (!haystack.includes(parsed.keyword)) return false;
  }

  return true;
}
