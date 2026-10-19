import { isInternalHoldReason } from "@/lib/release-fix-internal";
import type { ReleaseFixStatus } from "@/lib/release-fix-series";
import type { RcPublishNext } from "@/lib/release-rc-action";
import { describeReviewStageLabel, type ReviewEvidenceStage } from "@/lib/release-review-reevaluation";

/**
 * リリースの検証・修正画面の上部に出す「現在の状態・検証の要約・主操作」（#4398）。**純関数だけ**を置く。
 *
 * 現在状態は1つだけ決める。「停止」「要確認」「公開操作待ち」を並べて見せない。待てば進む状態は
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
  /** 全体レビューを最新の証跡で再実行する（#4632の導線。検証欄の再実行へ誘導する。#4640） */
  | "rerun_review"
  | "none";

export type OverviewAction = { kind: OverviewActionKind; label: string };

export const OVERVIEW_ACTION_LABEL: Record<Exclude<OverviewActionKind, "none">, string> = {
  create_issue: "修正Issueを作成",
  start_fix: "修正を開始",
  view_progress: "進捗を見る",
  accept_extra: "無関係な変更も含めて修正をリリースに反映",
  retry_rebuild: "ブランチ画面の「修正を入れて作り直す」で再試行",
  rerun_review: "最新の証跡で全体レビューを再実行",
};

const isActiveFixStatus = (status: ReleaseFixStatus) => status === "issue_created" || status === "fix_in_progress";

export type OverviewSeries = {
  status: ReleaseFixStatus;
  issueNumber: number;
  /** 修正を反映したリリースPR。作成前はnull（反映済みと呼ばない） */
  successorPrNumber: number | null;
  stopReason: string | null;
  /** 修正を反映したリリースの準備に失敗して止まっている */
  rebuildFailed?: boolean;
  /** 修正PR。作成前はnull（実装中と修正PRの検証中を分ける。#4498） */
  fixPrNumber?: number | null;
  /** 内部確認の一時停止（#4587）。停止していなければnullまたは省略 */
  internalPause?: { message: string; nextAction: string; autoResumable: boolean } | null;
};

/**
 * リリース完了系列（#4480）の現在の工程。進行中の系列があれば、見出しは修正前の指摘ではなくこの工程を使う（#4498）。
 * 操作が要る・完了・停止の系列はここに渡さない（判断は既存の分岐に任せる）
 */
export type OverviewCompletion = {
  status: string;
  active: boolean;
  candidatePrNumber: number;
};

type CheckState = "not_run" | "waiting" | "running" | "passed" | "failed" | "needs_check" | "not_applicable" | "invalidated";

export type OverviewChecks = {
  aiReview: {
    state: CheckState;
    findingCount: number;
    /** 状態の理由（未確認範囲など）。取得できていなければ省略 */
    reason?: string | null;
    reviewedFiles?: number | null;
    totalFiles?: number | null;
    /** 結果の記録時刻（ISO）。統合検証より古いかの判定に使う（#4640） */
    updatedAt?: string | null;
    /** 統合検証の証跡から見た共通の段階（#4664）。旧応答では省略 */
    stage?: ReviewEvidenceStage;
  };
  integration: { state: CheckState; reason?: string | null; updatedAt?: string | null };
  /** iOS検証。対象外・未設定なら省略 */
  mac?: { state: "passed" | "failed" | "running" | "other" } | null;
};

export type FixOverview = {
  tone: OverviewTone;
  /** 状態のラベル（1つだけ） */
  pill: string;
  headline: string;
  /** 補足（理由。現在の操作に必要なものなので折りたたまない） */
  detail: string | null;
  /** 全体レビュー・統合検証・iOS検証の短い要約 */
  checksLine: string | null;
  /** 残っている指摘の件数。取得できていないときはnull */
  remainingFindings: number | null;
  action: OverviewAction;
  /**
   * 待てば自動で進む状態か（#4428）。trueのときだけ画面は「操作は不要です」と添える。
   * 失敗・取得不能・判断待ち・未開始は待機扱いしない
   */
  autoProgress: boolean;
};

/**
 * 利用者に見せる修正の工程（#4428）。内部の7段階（`RELEASE_FIX_STEPS`）を4つにまとめる。
 * 修正の記録（系列）があるリリースにだけ使い、修正の無い通常リリースには出さない
 */
export const RELEASE_FIX_PHASES = ["修正", "取り込み", "再検証", "公開"] as const;

/** `RELEASE_FIX_STEPS`の番号（0始まり）を`RELEASE_FIX_PHASES`の番号へ */
export function releaseFixPhaseIndex(stepIndex: number): number {
  if (stepIndex <= 2) return 0; // Issue作成・計画・実装・PR検証
  if (stepIndex <= 4) return 1; // develop取り込み・修正をリリースに反映
  if (stepIndex === 5) return 2; // 修正後のチェック
  return 3; // 本番承認待ち
}

function checkWord(state: CheckState, findingCount: number): string {
  switch (state) {
    case "passed":
      return "問題なし";
    case "failed":
      return findingCount > 0 ? `指摘${findingCount}件` : "失敗";
    case "needs_check":
      // 指摘0件の要確認は、確認できていない範囲があるだけ（修正が必要な指摘ではない。#4498）
      return findingCount > 0 ? `要確認${findingCount}件` : "指摘0件・範囲の確認待ち";
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
    `全体レビュー: ${checkWord(checks.aiReview.state, checks.aiReview.findingCount)}${isReviewCoverageGap(checks) && reviewCoverageText(checks.aiReview) ? `（${reviewCoverageText(checks.aiReview)}）` : ""}`,
    `統合検証: ${checkWord(checks.integration.state, 0)}`,
  ];
  if (checks.mac && checks.mac.state !== "other") {
    parts.push(`iOS検証: ${checks.mac.state === "passed" ? "問題なし" : checks.mac.state === "failed" ? "失敗" : "チェック中"}`);
  }
  return parts.join(" ／ ");
}

const isDone = (s: CheckState) => s === "passed" || s === "not_applicable";
const isBusy = (s: CheckState) => s === "running" || s === "waiting";
const isProblem = (s: CheckState) => s === "failed" || s === "needs_check";

/** 指摘0件で、確認範囲が足りないだけの全体レビュー。修正の対象にせず、成功にも変えない */
export function isReviewCoverageGap(checks: OverviewChecks): boolean {
  return checks.aiReview.state === "needs_check" && checks.aiReview.findingCount === 0;
}

/** 「65/71ファイルを確認」。件数が取れたときだけ返す */
export function reviewCoverageText(review: OverviewChecks["aiReview"]): string | null {
  const { reviewedFiles, totalFiles } = review;
  return typeof reviewedFiles === "number" && typeof totalFiles === "number" ? `${reviewedFiles}/${totalFiles}ファイルを確認` : null;
}

/** 実行中・待機の統合検証を待っていたことを示す未確認理由か */
const WAITING_REASON = /実行中|待機|完了していません|結果待ち|判定が出ていません/;

/**
 * 全体レビューの要確認が、統合検証の結果待ちだった時点の理由を保持しているか（#4640）。
 * 統合検証が今は終了しており、レビューより新しい（または理由が実行中・待機を指す）ときだけtrue。
 * 統合検証が実行中・失敗・未取得のときは、現在も待つ理由なのでfalse
 */
export function isStaleReviewWait(checks: OverviewChecks): boolean {
  if (checks.aiReview.state !== "needs_check" || !isDone(checks.integration.state)) return false;
  const r = checks.aiReview.updatedAt;
  const i = checks.integration.updatedAt;
  const newer = !!r && !!i && Date.parse(i) > Date.parse(r);
  return newer || WAITING_REASON.test(checks.aiReview.reason ?? "");
}

export function describeFixOverview(input: {
  /** 表示する系列。進行中のものを優先して渡す。無ければnull */
  series: OverviewSeries | null;
  /** 現在のSHAの検証結果。取得できなければnull */
  checks: OverviewChecks | null;
  /** 検証結果の取得に失敗した */
  checksError?: boolean;
  /** 進行中のリリース完了系列（#4498）。無ければnull */
  completion?: OverviewCompletion | null;
  /**
   * 渡した検証結果が修正前（旧SHA）のものか（#4635）。falseなら最新SHAの結果として扱う。
   * 省略時は従来どおり、再チェック中の系列があれば修正前の結果とみなす
   */
  previousResults?: boolean;
  /**
   * 新方式の候補が、いま本番公開へ進めない理由（#4635）。合格後の「公開操作待ち」の代わりに、
   * 工程に合う見出し（公開準備へ進む・公開準備中など）を出す。進める・旧方式・未取得ならnullか省略
   */
  publishBlock?: { next: RcPublishNext; message: string } | null;
}): FixOverview {
  const { series, checks, checksError, completion } = input;
  const checksLine = summarizeChecks(checks);
  const findings = checks ? checks.aiReview.findingCount : null;
  const base = { checksLine, remainingFindings: findings, autoProgress: false } as const;
  const none: OverviewAction = { kind: "none", label: "" };
  const act = (kind: Exclude<OverviewActionKind, "none">): OverviewAction => ({ kind, label: OVERVIEW_ACTION_LABEL[kind] });

  // 修正前の指摘の説明。実行中の見出しの下に「修正対象」として添える（見出しにはしない。#4498）
  const priorNote =
    checks && checks.aiReview.findingCount > 0 ? `修正対象: 未解決の指摘${checks.aiReview.findingCount}件（修正前のレビュー結果）。` : null;
  const viewProgress: OverviewAction = series ? act("view_progress") : none;

  // 実際に進行中の完了系列を、修正前の指摘より先に見出しへ反映する。修正Issue作成は重ねて出さない
  if (completion?.active) {
    if (completion.status === "investigating") {
      return { ...base, tone: "progress", pill: "原因調査中", headline: "失敗の原因を調べています", detail: priorNote, action: viewProgress, autoProgress: true };
    }
    if (completion.status === "fixing") {
      return { ...base, tone: "progress", pill: "修正中", headline: "指摘への修正とレビューを進めています", detail: priorNote, action: viewProgress, autoProgress: true };
    }
    if (completion.status === "checking") {
      return {
        ...base,
        tone: "progress",
        pill: "修正後の再検証中",
        headline: `修正を反映した候補 #${completion.candidatePrNumber} を検証しています`,
        detail: "修正前のレビュー結果は履歴として扱い、現在の結果には使いません。",
        action: viewProgress,
        autoProgress: true,
      };
    }
  }

  // 作り直し・再チェック中は、修正前の結果を現在状態に使わない
  if (series?.status === "rebuilding") {
    return { ...base, tone: "progress", pill: "修正取り込み準備中", headline: "修正を反映したリリース候補を準備しています", detail: "完了すると、修正後のチェックが始まります。", action: { kind: "view_progress", label: OVERVIEW_ACTION_LABEL.view_progress }, autoProgress: true };
  }
  // 最新SHAの結果が出ている（成否が確定した）なら、系列が再チェック中でも「チェック中・操作不要」に固定しない（#4635）。
  // 失敗・要確認は理由と操作を、合格は公開操作待ちを、現在の結果として見せる
  const currentResultsSettled =
    input.previousResults === false &&
    checks !== null &&
    (isProblem(checks.aiReview.state) || isProblem(checks.integration.state) || (isDone(checks.aiReview.state) && isDone(checks.integration.state)));
  if ((series?.status === "reverifying" && !currentResultsSettled) || (series?.successorPrNumber != null && checks && (isBusy(checks.aiReview.state) || isBusy(checks.integration.state)))) {
    return { ...base, tone: "progress", pill: "チェック中", headline: "修正後のチェックを実行しています", detail: "結果が出ると、この表示が更新されます。", action: { kind: "view_progress", label: OVERVIEW_ACTION_LABEL.view_progress }, autoProgress: true };
  }
  // 内部確認が一時停止している（#4587）。作業は失われておらず、原因ごとの操作で再開できる。実行障害は本人確認待ちにしない
  if (series && isActiveFixStatus(series.status) && series.internalPause) {
    const pause = series.internalPause;
    return {
      ...base,
      tone: "warn",
      pill: pause.autoResumable ? "一時停止（再開可）" : "一時停止",
      headline: "修正を一時停止しています。作業内容と指摘の記録は保持されています",
      detail: `${pause.message}。次の操作: ${pause.nextAction}`,
      action: act("view_progress"),
    };
  }
  // 内部確認（#4410）が済まないまま修正PRが現れた。無関係な変更の確認（accept_extra）とは別なので、操作を出し分ける
  if (series?.status === "awaiting_decision" && isInternalHoldReason(series.stopReason)) {
    return { ...base, tone: "warn", pill: "内部確認が必要", headline: "修正の内部確認が完了していないため、リリースへの反映を保留しています", detail: series.stopReason, action: act("view_progress") };
  }
  if (series?.status === "awaiting_decision") {
    return { ...base, tone: "warn", pill: "あなたの操作が必要", headline: "修正の続行に、あなたの判断が必要です", detail: series.stopReason, action: act("accept_extra") };
  }
  // 準備の失敗は、チェック結果（修正前のもの）や「修正Issueを作成」より先に決める。Issueは作成済みで、重複して作らない
  if (series?.status === "stopped" && series.rebuildFailed) {
    return { ...base, tone: "bad", pill: "準備に失敗", headline: "修正を反映したリリースの準備に失敗しました", detail: series.stopReason, action: act("retry_rebuild") };
  }
  if (series?.status === "issue_created") {
    return { ...base, tone: "warn", pill: "あなたの操作が必要", headline: "修正Issueを作成しました。修正はまだ始まっていません", detail: null, action: act("start_fix") };
  }
  if (series?.status === "fix_in_progress") {
    // 修正PRが出ていれば、実装は済んでCI・レビューを待っている段階
    if (series.fixPrNumber != null) {
      return { ...base, tone: "progress", pill: "修正PRの検証中", headline: `修正PR #${series.fixPrNumber} のCI・レビューを待っています`, detail: priorNote, action: act("view_progress"), autoProgress: true };
    }
    return { ...base, tone: "progress", pill: "修正中", headline: `指摘への修正内容を実装しています（修正Issue #${series.issueNumber}）`, detail: priorNote, action: act("view_progress"), autoProgress: true };
  }
  if (series?.status === "fix_merged") {
    return { ...base, tone: "progress", pill: "修正取り込み準備中", headline: "修正をdevelopへ取り込みました。リリースへの反映を待っています", detail: null, action: act("view_progress"), autoProgress: true };
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
  // 全体レビューのコード確認は済み、統合検証の証跡を待っている／その証跡で再評価している（#4664）。
  // どちらも待てば進む段階で、修正Issueの作成や手動の再実行を主操作にしない（統合検証の失敗は下の分岐が先に拾う）
  const stage = checks.aiReview.stage;
  if (stage && (stage.kind === "integration_waiting" || stage.kind === "reevaluating") && !isProblem(checks.integration.state)) {
    const waiting = stage.kind === "integration_waiting";
    return {
      ...base,
      tone: "progress",
      pill: describeReviewStageLabel(stage),
      headline: waiting
        ? "全体レビューのコード確認は済みました。統合検証の結果を待っています"
        : "統合検証の結果で、全体レビューの未確認項目を自動で再評価しています",
      detail: waiting
        ? "統合検証が終わると、その結果に依存する項目だけを自動で再評価します。全体レビューはまだ完了していません。"
        : "確認済みの範囲・指摘と採否は引き継ぎます。修正Issue・PR・候補は増えません。",
      action: none,
      autoProgress: true,
    };
  }
  // 指摘0件でレビュー範囲だけ不足（例: 65/71ファイル）。修正Issueの作成を主操作にせず、成功にも変えない
  if (isReviewCoverageGap(checks) && !isProblem(checks.integration.state)) {
    const coverage = reviewCoverageText(checks.aiReview);
    return {
      ...base,
      tone: "warn",
      pill: "レビュー範囲の確認待ち",
      headline: "指摘は0件ですが、レビューで確認できていない範囲があります",
      detail: [coverage, checks.aiReview.reason ?? null, "修正は実行中ではありません。確認不足を修正指摘や成功には変換しません。"].filter(Boolean).join(" ／ "),
      action: none,
    };
  }
  // 全体レビューの実行失敗（指摘なし）は、コードの指摘ではない。修正Issueの作成を促さない
  if (checks.aiReview.state === "failed" && checks.aiReview.findingCount === 0 && !isProblem(checks.integration.state)) {
    return { ...base, tone: "bad", pill: "レビューの実行に失敗", headline: "全体レビューを完了できませんでした。問題なしとは扱いません", detail: [checks.aiReview.reason ?? null, "再実行は、下の検証結果の「全体レビュー」から行えます。"].filter(Boolean).join(" ／ "), action: none };
  }
  // 全体レビューが統合検証の結果待ち時点の未確認理由を保持している。統合検証は今は終了しているので、
  // 「前回レビュー時点」の理由として分け、最新の証跡での再レビューを主操作にする。指摘は消さず併記する
  if (isStaleReviewWait(checks) && checks.aiReview.state === "needs_check") {
    const n = checks.aiReview.findingCount;
    return {
      ...base,
      tone: "warn",
      pill: "要確認で終了",
      headline: "全体レビューは終了しています。統合検証の結果を反映して再レビューできます",
      detail: [
        `前回レビュー時点の理由: ${checks.aiReview.reason ?? "統合検証の結果待ち"}`,
        "統合検証は現在、結果が出ています（実行中のジョブはありません）。",
        n > 0 ? `未解決の指摘${n}件は再レビューでも消えません。再レビュー後に残れば修正Issueを作成します。` : null,
      ].filter(Boolean).join(" "),
      action: act("rerun_review"),
    };
  }
  if (problems) {
    const n = checks.aiReview.findingCount;
    const left = n > 0 ? `${n}件の指摘` : "指摘";
    return {
      ...base,
      tone: "bad",
      pill: "修正が必要",
      headline: reflected ? `修正を反映しましたが、チェックで${left}が残っています` : n > 0 ? `チェックで${n}件の指摘があります` : "チェックで問題が見つかりました",
      detail: series?.status === "stopped" ? series.stopReason : null,
      action: act("create_issue"),
    };
  }
  if (isBusy(checks.aiReview.state) || isBusy(checks.integration.state)) {
    return { ...base, tone: "progress", pill: "チェック中", headline: "チェックを実行しています", detail: "結果が出ると、この表示が更新されます。", action: none, autoProgress: true };
  }
  if (isDone(checks.aiReview.state) && isDone(checks.integration.state) && input.publishBlock && input.publishBlock.next !== "none") {
    // 合格しても、公開準備（正式バンプ・最終検証）が済むまでは公開操作待ちにしない（#4635）
    const next = input.publishBlock.next;
    const waiting = next === "wait";
    return {
      ...base,
      tone: next === "recheck" ? "muted" : "ok",
      pill: waiting ? "公開準備中" : next === "recheck" ? "状態を確認中" : "検証に合格",
      headline: waiting ? "公開準備を進めています" : next === "recheck" ? "候補の状態を確認しています" : "チェックを通過しました。公開準備へ進めます",
      detail: input.publishBlock.message,
      action: none,
      autoProgress: waiting,
    };
  }
  if (isDone(checks.aiReview.state) && isDone(checks.integration.state)) {
    return { ...base, tone: "ok", pill: "公開操作待ち", headline: reflected ? "修正を反映し、チェックを通過しました" : "チェックを通過しました", detail: "本番へのマージは、確認画面で対象を確かめてから人が行います。マージ後、デプロイが完了するまでは本番に反映されていません。", action: none };
  }
  if (series?.status === "stopped") {
    return { ...base, tone: "bad", pill: "修正が止まっています", headline: "修正が止まっています", detail: series.stopReason, action: act("create_issue") };
  }
  return { ...base, tone: "muted", pill: "チェック未実施", headline: "チェックはまだ実施されていません", detail: null, action: none };
}
