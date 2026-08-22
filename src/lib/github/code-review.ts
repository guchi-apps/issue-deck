import { toJstParts } from "@/lib/format-date-time";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * リポジトリ全体のコードレビュー（#698）。Claude Codeの`/code-review`に当たるものを、
 * issue-deckの画面から1リポジトリまるごとに対して走らせる。
 *
 * **記録はGitHubのIssue1件**で、指摘はそのIssueへのコメントとして返る。横断質問（#1454）と
 * 同じ形にしてあるので、通知・実行中バッジ・実行の取り消し・スマホ表示といった既存の仕組みが
 * そのまま効く。issue-deck側にレビュー専用のテーブルも取得口も足していない。
 *
 * ここに置くのは**文字列の組み立てと読み取りだけ**（純粋関数）。DBに触る処理は
 * `lib/dispatch/jobs.ts`、実行そのものは`scripts/start-code-review.sh`。
 */

/**
 * レビュー依頼コメントに付けるマーカー。**「このIssueがコードレビューである」ことの唯一の目印**で、
 * 結果側の`CODE_REVIEW_REPORT_MARKER`と対になる。
 *
 * 本文に`@claude`を含めないため、`claude-issue-dispatch.yml`のトリガー条件
 * （`startsWith(github.event.comment.body, '@claude')`）には掛からない。レビューを走らせるのは
 * サブPCのセッションで、GitHub Actionsではない（横断質問と同じ立場）。
 */
export const CODE_REVIEW_REQUEST_MARKER = "<!-- issue-deck-code-review -->";

/** レビュー結果コメントに付けるマーカー。画面はこれが付いたコメントだけを指摘カードとして読む */
export const CODE_REVIEW_REPORT_MARKER = "<!-- issue-deck-code-review-report -->";

/**
 * レビューIssueのタイトルに付ける接頭辞。質問Issue（`[質問] `）と同じ形にしてあり、
 * **このタイトルかどうかでレビューIssueを判定する**（ラベルは対象リポジトリに定義が無いことがある）。
 */
export const CODE_REVIEW_TITLE_PREFIX = "[レビュー] ";

/** 重点的に見てほしい観点の最大長。長い指定は本文へ書いてもらう */
export const CODE_REVIEW_FOCUS_MAX_LENGTH = 500;

/**
 * レビューIssueのタイトルを機械的に組み立てる（例: `[レビュー] issue-deck（2026-08-22）`）。
 *
 * **日付を入れるのは、同じリポジトリを何度もレビューするため。** 入れないと一覧で
 * 見分けが付かず、GitHub側でも同名のIssueが並ぶ。日付は日本時間で入れる（#1977）。
 */
export function buildCodeReviewTitle(repositoryFullName: string, now: Date = new Date()): string {
  const name = repositoryFullName.split("/")[1] ?? repositoryFullName;
  const parts = toJstParts(now);
  const date = parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : "";
  return `${CODE_REVIEW_TITLE_PREFIX}${name}${date ? `（${date}）` : ""}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** レビューIssueの本文。観点が空でも「リポジトリ全体を見る」ことが読めるようにしておく */
export function buildCodeReviewIssueBody(params: {
  repositoryFullName: string;
  focus: string;
}): string {
  const focus = params.focus.trim();
  const lines = [
    `${params.repositoryFullName} のリポジトリ全体をコードレビューします。`,
    "",
    "## 重点的に見る観点",
    "",
    focus === "" ? "指定なし（リポジトリ全体を見る）" : focus,
  ];
  return lines.join("\n");
}

/**
 * レビュー依頼コメントの本文。**Actionsを起こさない形**（本文の先頭に`@claude`を置かない）に
 * レビューのマーカーを足したもの。
 */
export function codeReviewRequestCommentBody(focus: string): string {
  const trimmed = focus.trim();
  const body =
    trimmed === ""
      ? "リポジトリ全体のコードレビューを依頼しました（観点の指定なし）。"
      : `リポジトリ全体のコードレビューを依頼しました。\n\n重点的に見る観点: ${trimmed}`;
  return `${body}\n\n${CODE_REVIEW_REQUEST_MARKER}`;
}

/** 「コードレビューを実行」から作られたIssueかどうか */
export function isCodeReviewIssue(issue: Pick<Issue, "title">): boolean {
  return issue.title.startsWith(CODE_REVIEW_TITLE_PREFIX);
}

/** そのコメントがレビュー結果かどうか */
export function isCodeReviewReportComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.includes(CODE_REVIEW_REPORT_MARKER);
}

/** 指摘の重要度。**3段だけ**にして、色と意味が1対1で対応するようにする */
export type CodeReviewSeverity = "high" | "medium" | "low";

const SEVERITY_BY_LABEL: Record<string, CodeReviewSeverity> = {
  重大: "high",
  中: "medium",
  軽微: "low",
};

const SEVERITY_LABELS: Record<CodeReviewSeverity, string> = {
  high: "重大",
  medium: "中",
  low: "軽微",
};

export function describeCodeReviewSeverity(severity: CodeReviewSeverity): string {
  return SEVERITY_LABELS[severity];
}

/** 重要度の並び（重いものが先）。一覧・件数の表示はこの順に揃える */
export const CODE_REVIEW_SEVERITIES: readonly CodeReviewSeverity[] = ["high", "medium", "low"];

export type CodeReviewFinding = {
  severity: CodeReviewSeverity;
  /** 指摘の見出し（1行） */
  title: string;
  /** `correctness`・`security`など。書かれていなければ`null` */
  category: string | null;
  /** `src/lib/foo.ts:42`。書かれていなければ`null` */
  location: string | null;
  /** 見出しと属性行を除いた本文（Markdownのまま） */
  body: string;
};

export type CodeReviewReport = {
  /** 「読んだコード: …」の1行。書かれていなければ`null` */
  basis: string | null;
  /** 最初の見出しより前の総評（Markdownのまま） */
  summary: string;
  findings: CodeReviewFinding[];
};

const BASIS_PREFIX = "読んだコード:";
const CATEGORY_PREFIX = "- 種別:";
const LOCATION_PREFIX = "- 場所:";

/**
 * レビュー結果コメントを指摘の配列として読む（#698）。マーカーが無ければ`null`。
 *
 * 読む書式は`scripts/prompts/code-review-agent.md`が指示しているもので、**GitHubの画面でも
 * そのまま読める形**にしてある（機械可読のためのJSONブロックを別に持たせない。持たせると
 * コメントに人が読まない塊が並ぶうえ、書式が2つになって片方だけ崩れる）。
 *
 * ```text
 * <!-- issue-deck-code-review-report -->
 * 読んだコード: guchi-apps/issue-deck origin/develop 9b25283b・2026-08-22
 *
 * （総評）
 *
 * ### [重大] 未完了ジョブの判定が種別を見ていない
 *
 * - 種別: correctness
 * - 場所: src/lib/dispatch/dispatch-job.ts:412
 *
 * （本文）
 * ```
 *
 * **見出しの形が違う指摘は落とす。** 拾えた指摘が1件も無ければ`findings`が空の`CodeReviewReport`
 * を返し、呼び出し側は従来どおりのMarkdownとして出す（書式が崩れたことを理由に、投稿された
 * 結果そのものを画面から消さない）。
 */
export function parseCodeReviewReport(body: string): CodeReviewReport | null {
  if (!body.includes(CODE_REVIEW_REPORT_MARKER)) return null;

  const lines = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("<!--"))
    .map((line) => line.replace(/\r$/, ""));

  let basis: string | null = null;
  const summaryLines: string[] = [];
  const findings: CodeReviewFinding[] = [];
  let current: { finding: CodeReviewFinding; bodyLines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    findings.push({ ...current.finding, body: trimBlankEdges(current.bodyLines).join("\n") });
    current = null;
  };

  for (const line of lines) {
    const heading = parseFindingHeading(line);
    if (heading) {
      flush();
      current = {
        finding: { ...heading, category: null, location: null, body: "" },
        bodyLines: [],
      };
      continue;
    }

    if (current) {
      const trimmed = line.trim();
      if (current.bodyLines.length === 0 && trimmed.startsWith(CATEGORY_PREFIX)) {
        current.finding.category = trimmed.slice(CATEGORY_PREFIX.length).trim() || null;
        continue;
      }
      if (current.bodyLines.length === 0 && trimmed.startsWith(LOCATION_PREFIX)) {
        current.finding.location = stripCode(trimmed.slice(LOCATION_PREFIX.length).trim()) || null;
        continue;
      }
      if (current.bodyLines.length === 0 && trimmed === "") continue;
      current.bodyLines.push(line);
      continue;
    }

    if (basis === null && line.trim().startsWith(BASIS_PREFIX)) {
      basis = line.trim().slice(BASIS_PREFIX.length).trim() || null;
      continue;
    }
    summaryLines.push(line);
  }
  flush();

  return { basis, summary: trimBlankEdges(summaryLines).join("\n"), findings };
}

/** `### [重大] タイトル` の行を読む。重要度が3つのどれでもない見出しは指摘として扱わない */
function parseFindingHeading(line: string): { severity: CodeReviewSeverity; title: string } | null {
  const matched = /^#{2,4}\s*\[([^\]]+)\]\s*(.+)$/.exec(line.trim());
  if (!matched) return null;
  const severity = SEVERITY_BY_LABEL[matched[1].trim()];
  if (!severity) return null;
  const title = matched[2].trim();
  if (title === "") return null;
  return { severity, title };
}

/** `` `src/foo.ts:1` `` のようにコード表記で書かれていても、パスだけを取り出す */
function stripCode(value: string): string {
  return value.replace(/^`+|`+$/g, "").trim();
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * コメント配列（時系列順）から、いちばん新しいレビュー結果を読む。
 * 何度もレビューし直した場合は**最後の結果だけ**を画面に出す（古い指摘はコメント欄に残る）。
 */
export function findLatestCodeReviewReport(
  comments: readonly Pick<IssueComment, "body">[],
): CodeReviewReport | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const report = parseCodeReviewReport(comments[i].body);
    if (report) return report;
  }
  return null;
}

/** 重要度ごとの件数。0件のものも含めて返す（表示側で出し分ける） */
export function countCodeReviewFindings(
  findings: readonly CodeReviewFinding[],
): Record<CodeReviewSeverity, number> {
  return {
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
  };
}

/**
 * レビュー結果がまだ返っていないかどうか（依頼コメントの後に結果コメントが無い）。
 *
 * 質問の`isQaAnswerPending`と同じ考え方で、**画面の「レビュー中」表示の根拠**になる。
 */
export function isCodeReviewPending(comments: readonly Pick<IssueComment, "body">[]): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (isCodeReviewReportComment(comments[i])) return false;
    if (comments[i].body.includes(CODE_REVIEW_REQUEST_MARKER)) return true;
  }
  return false;
}

/**
 * 指摘から起票するIssueの下書き（#698）。**ここでは起票しない。**
 * 埋めた新規作成ダイアログを開くだけで、実際に立てるかどうかは指摘を読んだ人が決める
 * （実機設定の切り出し`buildInfraConfigIssueDraft`と同じ立場）。
 */
export function buildCodeReviewFindingIssueDraft(params: {
  finding: CodeReviewFinding;
  /** レビュー対象＝起票先のリポジトリ */
  repositoryFullName: string;
  /** 起点になったレビューIssue */
  reviewNumber: number;
}): { repositoryFullName: string; title: string; body: string } {
  const { finding } = params;
  const bodyLines = [
    `${params.repositoryFullName} のコードレビュー（#${params.reviewNumber}）で見つかった指摘です。`,
    "",
    `- 重要度: ${describeCodeReviewSeverity(finding.severity)}`,
  ];
  if (finding.category) bodyLines.push(`- 種別: ${finding.category}`);
  if (finding.location) bodyLines.push(`- 場所: \`${finding.location}\``);
  bodyLines.push("", "## 指摘", "", finding.title);
  if (finding.body.trim() !== "") bodyLines.push("", finding.body.trim());
  bodyLines.push("", "## 関連", "", `- 起点のレビュー: #${params.reviewNumber}`);

  return {
    repositoryFullName: params.repositoryFullName,
    title: finding.title,
    body: bodyLines.join("\n"),
  };
}
