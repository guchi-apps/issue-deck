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

export function matchesSearchQuery(issue: Issue, q: string): boolean {
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

  if (parsed.keyword) {
    const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
    if (!haystack.includes(parsed.keyword)) return false;
  }

  return true;
}
