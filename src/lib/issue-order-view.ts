import {
  ISSUE_ORDER_BODY_HEAD_LENGTH,
  ISSUE_ORDER_CANDIDATE_LIMIT,
  type IssueOrderCandidate,
  type IssueOrderResult,
} from "@/lib/claude/issue-order";
import type { Issue } from "@/types/issue";

/**
 * 候補Issueと応答の突き合わせに使うキー。プロンプトにも同じ形で載る（#1853）。
 * `use-issue-ai-search.ts`の`buildIssueSearchKey`と同じ形にしてある。
 */
export function buildIssueOrderKey(issue: Issue): string {
  return `${issue.repositoryFullName}#${issue.number}`;
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveAgeDays(issue: Issue, now: Date): number {
  const createdAt = new Date(issue.createdAt).getTime();
  if (Number.isNaN(createdAt)) return 0;
  return Math.max(0, Math.floor((now.getTime() - createdAt) / MILLIS_PER_DAY));
}

/**
 * Issueの本文から、プロンプトへ載せる冒頭部分を取り出す。
 *
 * **画像のURLとHTMLコメントは落とす。** issue-deckから貼られた画像は
 * `.../api/issues/images/<UUID>`という長いURLになり、役割マーカー（`<!-- issue-deck-agent:... -->`）と
 * あわせて、冒頭200文字が判定に使えない文字列で埋まることがある。
 */
export function buildIssueOrderBodyHead(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*`>_~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ISSUE_ORDER_BODY_HEAD_LENGTH);
}

/**
 * 一覧に並んでいるIssueから、Claudeへ渡す候補を組み立てる。
 *
 * **並び順は呼び出し側（＝一覧の表示順）のまま**で、先頭から`ISSUE_ORDER_CANDIDATE_LIMIT`件までを
 * 対象にする。超過分が対象外であることは画面に出す（`issue-order-dialog.tsx`）。
 */
export function buildIssueOrderCandidates(issues: Issue[], now: Date): IssueOrderCandidate[] {
  return issues.slice(0, ISSUE_ORDER_CANDIDATE_LIMIT).map((issue) => ({
    key: buildIssueOrderKey(issue),
    title: issue.title,
    labels: issue.labels.map((label) => label.name),
    ageDays: resolveAgeDays(issue, now),
    bodyHead: buildIssueOrderBodyHead(issue.body),
  }));
}

export type IssueOrderEntry = {
  issue: Issue;
  reason: string;
};

export type IssueOrderView = {
  overview: string;
  /** 次に着手すべき1件。すべて見送られた場合や該当が無い場合はnull */
  top: IssueOrderEntry | null;
  /** 2位以降 */
  rest: IssueOrderEntry[];
  /** 実施しない方がよいと判断されたIssue */
  skip: IssueOrderEntry[];
};

const EMPTY_VIEW: IssueOrderView = { overview: "", top: null, rest: [], skip: [] };

function toEntries(
  items: IssueOrderResult["order"],
  byKey: Map<string, Issue>,
  dismissedKeys: ReadonlySet<string>,
): IssueOrderEntry[] {
  return items.flatMap((item) => {
    if (dismissedKeys.has(item.key)) return [];
    const issue = byKey.get(item.key);
    // 判定してから一覧が更新されるまでのあいだにcloseされたIssueは、行として出しても押せない
    return issue ? [{ issue, reason: item.reason }] : [];
  });
}

/**
 * 判定結果（キーの並び）を、画面が描ける形（Issueの並び）へ変換する（#1853）。
 *
 * **見送られた（「見送って次の候補へ」を押した）ものは着手順から外し、次の候補が繰り上がる。**
 * 現在地を添字で持たないのは、判定の後にIssueがcloseされて一覧から消えると添字がずれ、
 * 次の1件を飛ばしてしまうため（`use-manual-step-guide.ts`と同じ理由）。
 */
export function resolveIssueOrderView(
  result: IssueOrderResult | null,
  issues: Issue[],
  dismissedKeys: ReadonlySet<string>,
): IssueOrderView {
  if (!result) return EMPTY_VIEW;

  const byKey = new Map(issues.map((issue) => [buildIssueOrderKey(issue), issue]));
  const order = toEntries(result.order, byKey, dismissedKeys);

  return {
    overview: result.overview,
    top: order[0] ?? null,
    rest: order.slice(1),
    // 見送り候補は「やらない方がよい」という提示なので、着手順の見送り操作の影響を受けない
    skip: toEntries(result.skip, byKey, new Set()),
  };
}
