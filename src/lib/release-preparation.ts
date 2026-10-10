import type { RebuildSelection } from "@/lib/release-rebuild-selection";
import { redactDiagnosticText } from "@/lib/release-review-diagnostic";

/**
 * リリース準備（`reusable-release-develop-to-main.yml`の`release`ジョブ）の失敗の扱い（#4335）。
 * **純関数だけ**を置き、DB・GitHubへの操作は`release-preparation-run.ts`が持つ。
 *
 * 以前は失敗するたびに`notify-failure`ジョブが、Develop・ReleaseにいるIssue全件へ
 * `00.check-user`＋`01.check-blocked`を付け、他の理由ラベル（`01.check-plan`など）まで外していた。
 * 失敗は共通のリリース処理1件なのに、個別Issueが一斉に「確認待ち」へ落ち、本当に人の判断を
 * 待っているIssueと見分けが付かなくなる。いまは失敗をリリース画面へ1件として出し、Issueは
 * 本番反映待ちのまま保つ。
 */

/** 旧`notify-failure`がIssueへ投稿していたコメントの見分け方（本文の固定文言） */
export const LEGACY_RELEASE_FAILURE_NOTICE_TEXT =
  "develop→mainのリリースワークフロー（release-develop-to-main.yml）が失敗しました";
const FALLBACK_NOTICE_MARKER = "<!-- issue-deck-fallback-notice -->";

export const CHECK_USER = "00.check-user";
export const CHECK_BLOCKED = "01.check-blocked";

/** ラベル付与とコメント投稿を「同じ失敗通知」とみなす時刻のずれ（`gh issue comment`→`gh issue edit`の順） */
const PAIRING_WINDOW_MS = 3 * 60 * 1000;

export type IssueLabelEvent = {
  event: string;
  label: string | null;
  actorLogin: string | null;
  createdAt: string;
};

export type IssueCommentSummary = {
  body: string;
  authorLogin: string | null;
  createdAt: string;
};

function isBot(login: string | null): boolean {
  return !!login && login.endsWith("[bot]");
}

function isLegacyReleaseFailureNotice(comment: IssueCommentSummary): boolean {
  return (
    isBot(comment.authorLogin) &&
    comment.body.includes(LEGACY_RELEASE_FAILURE_NOTICE_TEXT) &&
    comment.body.includes(FALLBACK_NOTICE_MARKER)
  );
}

function latestLabeled(events: readonly IssueLabelEvent[], label: string): IssueLabelEvent | null {
  let latest: IssueLabelEvent | null = null;
  for (const event of events) {
    if (event.event !== "labeled" || event.label !== label) continue;
    if (!latest || Date.parse(event.createdAt) >= Date.parse(latest.createdAt)) latest = event;
  }
  return latest;
}

function pairedWithNotice(event: IssueLabelEvent | null, notices: readonly IssueCommentSummary[]): boolean {
  if (!event || !isBot(event.actorLogin)) return false;
  const at = Date.parse(event.createdAt);
  return notices.some((notice) => Math.abs(Date.parse(notice.createdAt) - at) <= PAIRING_WINDOW_MS);
}

/**
 * 旧`notify-failure`（リリース準備の失敗）が付けたと**確認できる**確認待ちラベルだけを返す。
 *
 * 外してよいのは次をすべて満たすときだけ。どれかが崩れたら何も外さない（由来不明なものは消さない）。
 *
 * - `00.check-user`の**最後の付与**がbotによるもので、同じ時刻帯にbotが投稿したリリース失敗の通知コメントがある
 *   （その後に別の理由で付け直されていれば、最後の付与はそちらになる）
 * - いま付いている理由ラベルが`01.check-blocked`だけ（または無し）。`01.check-input`・`01.check-plan`などが
 *   付いていれば、別の質問・承認を待っている
 * - `01.check-blocked`が付いているなら、その最後の付与も同じ通知と対になっている
 *
 * 付与済みのラベルへ`gh issue edit --add-label`しても付与イベントは残らないため、失敗の前から
 * 別の理由で`00.check-user`が付いていたIssueは、最後の付与が通知と対にならず外れない。
 */
export function releaseFailureDerivedLabels(input: {
  labels: readonly string[];
  events: readonly IssueLabelEvent[];
  comments: readonly IssueCommentSummary[];
}): string[] {
  if (!input.labels.includes(CHECK_USER)) return [];
  const notices = input.comments.filter(isLegacyReleaseFailureNotice);
  if (notices.length === 0) return [];

  const otherReasons = input.labels.filter(
    (name) => (name.startsWith("01.check-") || name === "00.qa-answered") && name !== CHECK_BLOCKED,
  );
  if (otherReasons.length > 0) return [];

  if (!pairedWithNotice(latestLabeled(input.events, CHECK_USER), notices)) return [];
  if (!input.labels.includes(CHECK_BLOCKED)) return [CHECK_USER];
  if (!pairedWithNotice(latestLabeled(input.events, CHECK_BLOCKED), notices)) return [];
  return [CHECK_USER, CHECK_BLOCKED];
}

export type WorkflowJobLike = {
  name?: string | null;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

/** 失敗したジョブと工程（ステップ）。`release`ジョブを優先し、無ければ最初に失敗したジョブ */
export function findFailedStep(jobs: readonly WorkflowJobLike[]): { jobName: string | null; stepName: string | null } {
  const failed = jobs.filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out");
  const job =
    failed.find((j) => j.name === "release" || (j.name ?? "").endsWith("/ release")) ?? failed[0] ?? null;
  if (!job) return { jobName: null, stepName: null };
  const step = (job.steps ?? []).find((s) => s.conclusion === "failure" || s.conclusion === "timed_out");
  return { jobName: job.name ?? null, stepName: step?.name ?? null };
}

const EXCERPT_MAX_LINES = 8;
const EXCERPT_MAX_CHARS = 2000;

/**
 * ジョブのログから`##[error]`の行だけを抜き出す（機密を除き、行数・文字数を絞る）。
 * 終了コードだけの行（`Process completed with exit code 1.`）は、他に行があれば落とす。
 */
export function extractErrorExcerpt(log: string): string | null {
  const lines = log
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf("##[error]");
      return at < 0 ? null : line.slice(at + "##[error]".length).trim();
    })
    .filter((line): line is string => !!line);
  const meaningful = lines.filter((line) => !/^Process completed with exit code \d+\.?$/.test(line));
  const picked = (meaningful.length > 0 ? meaningful : lines).slice(0, EXCERPT_MAX_LINES);
  if (picked.length === 0) return null;
  return redactDiagnosticText(picked.join("\n")).slice(0, EXCERPT_MAX_CHARS);
}

export type ReleasePreparationFailureView = {
  id: string;
  runUrl: string;
  event: string | null;
  bumpKind: string | null;
  jobName: string | null;
  stepName: string | null;
  errorExcerpt: string | null;
  /** 選んで作り直していたときの指定（元の候補と選んだPR）。再開時は現在の状態で検証し直す */
  rebuildSelection: RebuildSelection | null;
  createdAt: string;
};

/**
 * 画面に出す「次の操作」。**原因を推測で断定しない。** 以前の通知はどの失敗にも「GitHub Actions側の
 * 障害が原因の場合があります」と添えていたが、根拠が無いので出さない。
 */
export function releasePreparationNextAction(failure: Pick<ReleasePreparationFailureView, "errorExcerpt" | "stepName">): string {
  const text = failure.errorExcerpt ?? "";
  if (/取り消せませんでした|一致しません/.test(text)) {
    return "エラーに出ているコミット・ファイルをdevelopで確認してから「再開」してください。修正が要らない場合はそのまま再開できます。";
  }
  if (!failure.stepName && !failure.errorExcerpt) {
    return "失敗した工程を取得できませんでした。実行ログで原因を確認してから「再開」してください。";
  }
  return "エラーの内容を確認し、原因を取り除いてから「再開」してください。";
}
