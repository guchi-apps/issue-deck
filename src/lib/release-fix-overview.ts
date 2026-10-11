import type { ReleaseFixStatus } from "@/lib/release-fix-series";

/**
 * リリースの検証・修正画面の上部に出す「現在の状態・検証の要約・主操作」（#4398）。**純関数だけ**を置く。
 *
 * 現在状態は1つだけ決める。「停止」「要確認」「本番承認待ち」を並べて見せない。待てば進む状態は
 * 「チェック中」「修正中」とし、人の操作が要る状態だけ理由と操作を隣に出す。
 * 主操作は種別（`action.kind`）だけを返す。ボタンの実装（#4396の「修正を開始」など）は画面が差し込む。
 */

export type OverviewTone = "ok" | "warn" | "bad" | "progress" | "muted";

export type OverviewActionKind =
  /** 修正Issueを作る（既存の`ReleaseFixCreate`） */
  | "create_issue"
  /** 作成済みで未開始。#4396の「修正を開始」を差し込む位置 */
  | "start_fix"
  /** 実行中。修正Issue・PRで進捗を見る */
  | "view_progress"
  /** 判断待ち。無関係な変更も含めて反映する */
  | "accept_extra"
  /** 準備の失敗。修正Issueは作成済みなので作らず、ブランチ画面の「修正を入れて作り直す」から再試行する */
  | "retry_rebuild"
  | "none";

export type OverviewAction = { kind: OverviewActionKind; label: string };

export const OVERVIEW_ACTION_LABEL: Record<Exclude<OverviewActionKind, "none">, string> = {
  create_issue: "修正Issueを作成",
  start_fix: "修正を開始",
  view_progress: "進捗を見る",
  accept_extra: "無関係な変更も含めて修正をリリースに反映",
  retry_rebuild: "ブランチ画面の「修正を入れて作り直す」で再試行",
};

export type OverviewSeries = {
  status: ReleaseFixStatus;
  issueNumber: number;
  /** 修正を反映したリリースPR。作成前はnull（反映済みと呼ばない） */
  successorPrNumber: number | null;
  stopReason: string | null;
  /** 修正を反映したリリースの準備に失敗して止まっている */
  rebuildFailed?: boolean;
};

type CheckState = "not_run" | "waiting" | "running" | "passed" | "failed" | "needs_check" | "not_applicable" | "invalidated";

export type OverviewChecks = {
  aiReview: { state: CheckState; findingCount: number };
  integration: { state: CheckState };
  /** Mac検証。対象外・未設定なら省略 */
  mac?: { state: "passed" | "failed" | "running" | "other" } | null;
};

export type FixOverview = {
  tone: OverviewTone;
  /** 状態のラベル（1つだけ） */
  pill: string;
  headline: string;
  /** 補足（理由。現在の操作に必要なものなので折りたたまない） */
  detail: string | null;
  /** 全体レビュー・統合検証・Mac検証の短い要約 */
  checksLine: string | null;
  /** 残っている指摘の件数。取得できていないときはnull */
  remainingFindings: number | null;
  action: OverviewAction;
};

function checkWord(state: CheckState, findingCount: number): string {
  switch (state) {
    case "passed":
      return "問題なし";
    case "failed":
      return findingCount > 0 ? `指摘${findingCount}件` : "失敗";
    case "needs_check":
      return findingCount > 0 ? `要確認${findingCount}件` : "要確認";
    case "running":
    case "waiting":
      return "チェック中";
    case "not_applicable":
      return "対象外";
    case "invalidated":
      return "再チェック待ち";
    default:
      return "未実施";
  }
}

export function summarizeChecks(checks: OverviewChecks | null): string | null {
  if (!checks) return null;
  const parts = [
    `全体レビュー: ${checkWord(checks.aiReview.state, checks.aiReview.findingCount)}`,
    `統合検証: ${checkWord(checks.integration.state, 0)}`,
  ];
  if (checks.mac && checks.mac.state !== "other") {
    parts.push(`Mac検証: ${checks.mac.state === "passed" ? "問題なし" : checks.mac.state === "failed" ? "失敗" : "チェック中"}`);
  }
  return parts.join(" ／ ");
}

const isDone = (s: CheckState) => s === "passed" || s === "not_applicable";
const isBusy = (s: CheckState) => s === "running" || s === "waiting";
const isProblem = (s: CheckState) => s === "failed" || s === "needs_check";

export function describeFixOverview(input: {
  /** 表示する系列。進行中のものを優先して渡す。無ければnull */
  series: OverviewSeries | null;
  /** 現在のSHAの検証結果。取得できなければnull */
  checks: OverviewChecks | null;
  /** 検証結果の取得に失敗した */
  checksError?: boolean;
}): FixOverview {
  const { series, checks, checksError } = input;
  const checksLine = summarizeChecks(checks);
  const findings = checks ? checks.aiReview.findingCount : null;
  const base = { checksLine, remainingFindings: findings } as const;
  const none: OverviewAction = { kind: "none", label: "" };
  const act = (kind: Exclude<OverviewActionKind, "none">): OverviewAction => ({ kind, label: OVERVIEW_ACTION_LABEL[kind] });

  // 作り直し・再チェック中は、修正前の結果を現在状態に使わない
  if (series?.status === "rebuilding") {
    return { ...base, tone: "progress", pill: "修正版を準備中", headline: "修正版のリリースを準備しています", detail: "完了すると、修正後のチェックが始まります。", action: { kind: "view_progress", label: OVERVIEW_ACTION_LABEL.view_progress } };
  }
  if (series?.status === "reverifying" || (series?.successorPrNumber != null && checks && (isBusy(checks.aiReview.state) || isBusy(checks.integration.state)))) {
    return { ...base, tone: "progress", pill: "チェック中", headline: "修正後のチェックを実行しています", detail: "結果が出ると、この表示が更新されます。", action: { kind: "view_progress", label: OVERVIEW_ACTION_LABEL.view_progress } };
  }
  if (series?.status === "awaiting_decision") {
    return { ...base, tone: "warn", pill: "判断が必要", headline: "修正の続行に、あなたの判断が必要です", detail: series.stopReason, action: act("accept_extra") };
  }
  // 準備の失敗は、チェック結果（修正前のもの）や「修正Issueを作成」より先に決める。Issueは作成済みで、重複して作らない
  if (series?.status === "stopped" && series.rebuildFailed) {
    return { ...base, tone: "bad", pill: "準備に失敗", headline: "修正を反映したリリースの準備に失敗しました", detail: series.stopReason, action: act("retry_rebuild") };
  }
  if (series?.status === "issue_created") {
    return { ...base, tone: "warn", pill: "修正は未開始", headline: "修正Issueを作成しました。修正はまだ始まっていません", detail: null, action: act("start_fix") };
  }
  if (series?.status === "fix_in_progress") {
    return { ...base, tone: "progress", pill: "修正中", headline: "指摘への修正内容を作成しています", detail: null, action: act("view_progress") };
  }
  if (series?.status === "fix_merged") {
    return { ...base, tone: "progress", pill: "反映待ち", headline: "修正をdevelopへ取り込みました。リリースへの反映を待っています", detail: null, action: act("view_progress") };
  }

  // ここから先は、現在のSHAの検証結果で決める
  if (!checks) {
    return {
      ...base,
      tone: checksError ? "bad" : "muted",
      pill: checksError ? "取得できません" : "取得中",
      headline: checksError ? "検証結果を取得できません。問題なしとは扱いません" : "検証結果を取得しています",
      detail: null,
      action: none,
    };
  }
  const reflected = series?.successorPrNumber != null;
  const problems = isProblem(checks.aiReview.state) || isProblem(checks.integration.state);
  if (problems) {
    const n = checks.aiReview.findingCount;
    const left = n > 0 ? `${n}件の指摘` : "指摘";
    return {
      ...base,
      tone: "bad",
      pill: "指摘が残っています",
      headline: reflected ? `修正を反映しましたが、チェックで${left}が残っています` : n > 0 ? `チェックで${n}件の指摘があります` : "チェックで問題が見つかりました",
      detail: series?.status === "stopped" ? series.stopReason : null,
      action: act("create_issue"),
    };
  }
  if (isBusy(checks.aiReview.state) || isBusy(checks.integration.state)) {
    return { ...base, tone: "progress", pill: "チェック中", headline: "チェックを実行しています", detail: null, action: none };
  }
  if (isDone(checks.aiReview.state) && isDone(checks.integration.state)) {
    return { ...base, tone: "ok", pill: "本番承認待ち", headline: reflected ? "修正を反映し、チェックを通過しました" : "チェックを通過しました", detail: "本番へのマージ・デプロイは人が承認します。", action: none };
  }
  if (series?.status === "stopped") {
    return { ...base, tone: "bad", pill: "修正が止まっています", headline: "修正が止まっています", detail: series.stopReason, action: act("create_issue") };
  }
  return { ...base, tone: "muted", pill: "チェック未実施", headline: "チェックはまだ実施されていません", detail: null, action: none };
}
