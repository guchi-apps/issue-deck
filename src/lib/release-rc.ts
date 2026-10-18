/**
 * 正式版を上げる前に固定したリリース候補（#4495。以下「候補」）の判断。**純関数だけ**を置き、
 * GitHub・DB・workflowへの操作は`release-rc-run.ts`が持つ。
 *
 * 既存の`release-candidate-*.ts`は「リリースPR1本の検証状態」を扱う。ここで扱うのはDBの`ReleaseCandidate`
 * （物理PR・ブランチ・正式版とは別の論理候補）で、語を`rc`に分けて混ざらないようにしている。
 *
 * - 候補は`RC-<番号>`で識別し、更新ごとにrevisionと対象SHA（base/head）を持つ。正式版・公開タグ・公開用の
 *   更新履歴は作らない（公開準備で確定する。#4496）
 * - 状態は「記録で持つ段階（phase）」と「現在revisionの検証結果」から導出する。検証の合否は既存の
 *   `evaluateReleaseMergeGate`（base/head SHAが一致する記録だけを使う）をそのまま使い、旧revisionの結果や
 *   遅れて届いた結果を現在の合格として扱わない
 * - 次工程へ進めるか・revisionを更新できるかはサーバーがここで判定する（画面の表示だけで制御しない）
 */

import type { ReleaseMergeGate } from "@/lib/release-merge-gate";
import { PRODUCTION_COMPLETION_TEXT, PRODUCTION_STOP_TEXT, type ProductionStopReason } from "@/lib/release-production-stop";
import type { ProductionVerificationMethod } from "@/lib/release-production-verification";
import type { ReviewEvidenceStage } from "@/lib/release-review-reevaluation";

/** 候補の状態（画面・APIに出す12種）。`phase`と検証結果から`deriveRcStatus`が決める */
export const RC_STATUSES = [
  "creating",
  "awaiting_verification",
  "verifying",
  "needs_fix",
  "fixing",
  "ready_to_prepare",
  "preparing",
  "awaiting_approval",
  "deploying",
  "verifying_production",
  "production_stopped",
  "completed",
  "cancelled",
] as const;
export type RcStatus = (typeof RC_STATUSES)[number];

export const RC_STATUS_LABEL: Record<RcStatus, string> = {
  creating: "作成中",
  awaiting_verification: "検証待ち",
  verifying: "検証中",
  needs_fix: "要修正",
  fixing: "修正中",
  ready_to_prepare: "公開準備可能",
  preparing: "公開準備中",
  awaiting_approval: "本番承認待ち",
  deploying: "本番反映中",
  verifying_production: "稼働確認中",
  production_stopped: "稼働確認が停止",
  completed: "完了",
  cancelled: "中止",
};

/**
 * 記録で持つ段階。`review`の間の細かい状態（検証待ち・検証中・要修正・修正中・公開準備可能）は記録せず、
 * 現在revisionの検証結果と未完了の更新から導出する（記録と実データが食い違わないように）。
 * `preparing`以降は公開準備（#4496）が進める
 */
export const RC_PHASES = [
  "creating",
  "review",
  "preparing",
  "awaiting_approval",
  "deploying",
  "verifying_production",
  "completed",
  "cancelled",
] as const;
export type RcPhase = (typeof RC_PHASES)[number];

export function parseRcPhase(value: unknown): RcPhase | null {
  return typeof value === "string" && (RC_PHASES as readonly string[]).includes(value) ? (value as RcPhase) : null;
}

export function isRcPhaseTerminal(phase: RcPhase): boolean {
  return phase === "completed" || phase === "cancelled";
}

/** 段階の遷移表。ここに無い遷移はサーバーが拒否する */
const PHASE_TRANSITIONS: Record<RcPhase, readonly RcPhase[]> = {
  creating: ["review", "cancelled"],
  review: ["preparing", "cancelled"],
  // 公開準備の失敗は同じ候補の修正工程へ戻す（#4496）
  preparing: ["awaiting_approval", "review", "cancelled"],
  awaiting_approval: ["deploying", "review", "cancelled"],
  // mainへ入った後は取り消せない。deploy失敗は既存の本番復旧（#4451）が引き継ぐ
  deploying: ["verifying_production"],
  verifying_production: ["completed"],
  completed: [],
  cancelled: [],
};

export function canTransitionRcPhase(from: RcPhase, to: RcPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

/** 候補を取り消せる段階か（mainへのマージ以降は取り消せない） */
export function canCancelRc(phase: RcPhase): boolean {
  return canTransitionRcPhase(phase, "cancelled");
}

/** revisionの記録状態 */
export type RcRevisionStatus = "requested" | "applied" | "failed" | "expired";
export type RcRevisionReason = "initial" | "fix_import" | "history_repair" | "migration" | "finalize_bump";

export const RC_REVISION_REASON_LABEL: Record<RcRevisionReason, string> = {
  initial: "developから固定",
  fix_import: "関連修正の取り込み",
  history_repair: "履歴修復（mainの祖先のみ）",
  migration: "旧方式の候補から移行",
  finalize_bump: "公開準備の正式バンプ",
};

/** 結果を受け取れないまま要求を残しておく時間。過ぎたら`expired`にしてやり直せるようにする */
export const RC_REVISION_TTL_MS = 2 * 60 * 60 * 1000;

export function isRcRevisionPendingExpired(row: { status: string; createdAt: Date }, now: Date): boolean {
  return row.status === "requested" && now.getTime() - row.createdAt.getTime() >= RC_REVISION_TTL_MS;
}

/** 現在の物理PRの観測（GitHubから取り直した値）。PRが見つからなければnull */
export type RcPullRequestObservation = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  baseSha: string;
  headSha: string;
};

export type RcStatusInput = {
  phase: RcPhase;
  /** 適用済みの現在revision（無ければnull） */
  current: { revision: number; headSha: string | null } | null;
  /** 未完了の更新要求（無ければnull） */
  pending: { revision: number; reason: RcRevisionReason } | null;
  pullRequest: RcPullRequestObservation | null;
  /** 現在のPRのbase/headに対するマージゲート（`evaluateReleaseMergeGate(enforced: true)`の結果）。取れなければnull */
  gate: ReleaseMergeGate | null;
  /** 修正系列（#4317）が進行中か（指摘を直している途中） */
  fixInProgress: boolean;
  /** 全体レビューの共通の段階（#4664）。証跡待ち・確認中を「修正が必要」と取り違えないために使う。無ければ従来どおり */
  reviewStage?: ReviewEvidenceStage | null;
  /**
   * 有効な公開承認（#4666）があるか。承認済みの候補は最終検証の合格後に自動で本番公開するので、
   * 「本番承認待ち」ではなく「自動公開待ち」と出す。省略時はfalse（承認の記録が無い既存の候補）
   */
  publishApproved?: boolean;
  /**
   * 本番の稼働確認（#4712）。止まった理由・完了の根拠・後続の確認待ちか。省略時は従来どおり（確認中・完了）
   */
  production?: { stopReason: ProductionStopReason | null; method: ProductionVerificationMethod | null; awaitingSuccessor: boolean };
};

export type RcStatusView = {
  status: RcStatus;
  label: string;
  /** 状態の根拠・次に起きること（1文） */
  reason: string;
  /** 記録と実データが食い違っている（記録に無いpushなど）。人の確認が要る */
  attention: string | null;
};

function view(status: RcStatus, reason: string, attention: string | null = null, label: string = RC_STATUS_LABEL[status]): RcStatusView {
  return { status, label, reason, attention };
}

/**
 * 候補の状態を導出する。**検証の合否は現在revisionのhead（とPRの現在のbase）に一致する記録だけで決める**。
 * - 更新要求が未完了なら`fixing`（初回は`creating`）。旧revisionの結果は現在の合格にしない
 * - PRのheadが記録した現在revisionのheadと違う（記録に無いpush）なら、合格にせず`attention`を立てる
 */
export function deriveRcStatus(input: RcStatusInput): RcStatusView {
  const { phase } = input;
  if (phase === "cancelled") return view("cancelled", "候補は取り消されました。記録と過去の結果は残っています");
  const production = input.production;
  if (phase === "completed") {
    const method = production?.method ?? null;
    const text = (method && PRODUCTION_COMPLETION_TEXT[method]) || "本番へ反映し、稼働を確認しました";
    return method === "source_publish" ? view("completed", text, null, "ソース公開済み") : view("completed", text);
  }
  if ((phase === "deploying" || phase === "verifying_production") && production?.stopReason) {
    const text = PRODUCTION_STOP_TEXT[production.stopReason];
    const next = production.awaitingSuccessor
      ? "次の候補を開始済みです。次の候補の稼働確認で、この候補を含む版が稼働していると確かめた時点で完了します"
      : text.action;
    return view("production_stopped", `${text.cause}。${next}`, `稼働確認が止まっています（${text.label}）`, `稼働確認が停止（${text.label}）`);
  }
  if (phase === "deploying") return view("deploying", "mainへ反映しました。本番デプロイの完了を待っています");
  if (phase === "verifying_production") return view("verifying_production", "本番の稼働版を確認しています");
  // DBの段階よりGitHubのマージ事実を優先する。検証合格・稼働確認の代用にはしない（#4673）。
  if (input.pullRequest?.merged) return view("deploying", "候補のPRはmainへマージ済みです。本番反映の追跡状態を照合しています");
  if (phase === "awaiting_approval") {
    return input.publishApproved
      ? view("awaiting_approval", "公開承認済み。最終検証に合格したため、mainへのマージの条件を確かめて自動で本番公開します", null, "自動公開待ち")
      : view("awaiting_approval", "公開準備が済みました。この候補には公開承認の記録が無いため、内容を確かめて1回だけ承認してください", null, "公開承認待ち");
  }
  if (phase === "preparing") {
    return input.publishApproved
      ? view("preparing", "公開承認済み。正式版を確定し、最終検証をしています（合格後は自動で本番公開します）", null, "最終検証中")
      : view("preparing", "正式版を確定し、最終検証をしています");
  }

  if (input.pending) {
    if (input.pending.reason === "initial" || input.pending.reason === "migration" || input.current === null) {
      return view("creating", "developから固定した候補ブランチとPRを作っています");
    }
    return view("fixing", `revision ${input.pending.revision}（${RC_REVISION_REASON_LABEL[input.pending.reason]}）を作っています`);
  }
  if (phase === "creating" || input.current === null) {
    return view("creating", "候補の作成結果を待っています");
  }

  const pr = input.pullRequest;
  if (pr === null) return view("awaiting_verification", "候補のPRを取得できません。結果を推測しません", "候補のPRを取得できませんでした");
  if (pr.merged) return view("deploying", "候補のPRはmainへマージ済みです");
  if (pr.state === "closed") {
    return view("needs_fix", "候補のPRが閉じられています", "候補のPRが記録に無い操作で閉じられています。取り消すか、移行してください");
  }
  if (input.current.headSha !== null && pr.headSha !== input.current.headSha) {
    return view(
      "needs_fix",
      "候補ブランチが記録に無い変更で更新されています。この状態の結果は合格にしません",
      `記録したrevision ${input.current.revision}のhead（${input.current.headSha.slice(0, 7)}）と現在のhead（${pr.headSha.slice(0, 7)}）が違います`,
    );
  }

  const gate = input.gate;
  if (gate === null) return view("awaiting_verification", "検証結果を取得できません。結果を推測しません");
  const states = gate.views.map((v) => v.state);
  // 全体レビューのコード確認は済み、統合検証の証跡を待つ／その証跡で再評価している（#4664）。待てば進む段階で、
  // 統合検証側に失敗・要確認が無い限り「修正が必要」にしない（レビュー側の指摘があれば段階は要確認になる）
  const stage = input.reviewStage;
  if (
    stage &&
    (stage.kind === "integration_waiting" || stage.kind === "reevaluating") &&
    !gate.views.some((v) => v.kind === "integration" && (v.state === "failed" || v.state === "needs_check"))
  ) {
    return view(
      "verifying",
      stage.kind === "integration_waiting"
        ? `revision ${input.current.revision}: 全体レビューのコード確認は済み、統合検証の結果を待っています`
        : `revision ${input.current.revision}: 統合検証の結果で全体レビューの未確認項目を再評価しています`,
    );
  }
  if (states.some((s) => s === "failed") || gate.blockers.some((b) => b.state === "needs_check")) {
    return input.fixInProgress
      ? view("fixing", "指摘・失敗を直しています。修正を取り込むと新しいrevisionで検証し直します")
      : view("needs_fix", "検証で指摘・失敗が出ています。関連修正を取り込んで新しいrevisionで検証し直します");
  }
  if (input.fixInProgress) return view("fixing", "指摘・失敗を直しています");
  if (states.some((s) => s === "running")) return view("verifying", `revision ${input.current.revision}を検証しています`);
  if (states.some((s) => s === "waiting" || s === "not_run" || s === "invalidated")) {
    return view("awaiting_verification", `revision ${input.current.revision}の検証を待っています`);
  }
  if (gate.status === "ready" || gate.status === "not_enforced") {
    return gate.status === "ready"
      ? view("ready_to_prepare", `revision ${input.current.revision}が全体レビュー・統合検証に合格しました`)
      : view("awaiting_verification", "検証の強制が無効なため、合格と判定しません");
  }
  return view("needs_fix", "検証で確認が必要な結果があります");
}

// ---------------------------------------------------------------------------
// 取り込みの承認範囲

/** 取り込みを要求されたPR（サーバーがGitHubから取り直して検証済みのもの） */
export type RcImportCandidate = { number: number; mergeSha: string; title: string };

export type RcImportScope = {
  /** この候補の修正系列（#4317）の修正PR。承認なしで取り込める */
  relatedFixPrs: readonly number[];
  /** 既に承認済みの固定範囲外PR */
  approvedExtraPrs: readonly number[];
};

export type RcImportDecision =
  | { ok: true; prs: (RcImportCandidate & { related: boolean })[]; newlyApproved: number[] }
  | { ok: false; error: "approval_required"; unapproved: number[] }
  | { ok: false; error: "empty_selection" };

/**
 * 取り込むPRが承認範囲に収まっているかを決める。**関連修正（修正系列の修正PR）だけは承認なしで取り込める。**
 * それ以外は承認済みか、この要求で明示的に承認された（`approveExtra`に番号がある）ものに限る。
 * 範囲を勝手に広げない（依存PRを自動で足さない）
 */
export function decideRcImport(input: {
  selected: readonly RcImportCandidate[];
  scope: RcImportScope;
  approveExtra: readonly number[];
}): RcImportDecision {
  const unique = [...new Map(input.selected.map((pr) => [pr.number, pr])).values()];
  if (unique.length === 0) return { ok: false, error: "empty_selection" };
  const unapproved: number[] = [];
  const newlyApproved: number[] = [];
  const prs = unique.map((pr) => {
    const related = input.scope.relatedFixPrs.includes(pr.number);
    if (!related && !input.scope.approvedExtraPrs.includes(pr.number)) {
      if (input.approveExtra.includes(pr.number)) newlyApproved.push(pr.number);
      else unapproved.push(pr.number);
    }
    return { ...pr, related };
  });
  if (unapproved.length > 0) return { ok: false, error: "approval_required", unapproved };
  return { ok: true, prs, newlyApproved };
}

// ---------------------------------------------------------------------------
// workflowの報告の照合

export type RcReportObservation = {
  /** `release-rc/<番号>`をheadとする、base=mainのPR（GitHubから取り直す）。無ければnull */
  pullRequest: { number: number; baseSha: string; headSha: string; headRef: string } | null;
  /** 直前revisionのhead（または初回の固定SHA）が、新しいheadの祖先か */
  fastForward: boolean;
};

export type RcReportDecision =
  | { action: "apply"; prNumber: number; baseSha: string; headSha: string }
  | { action: "ignore"; reason: "not_pending" | "already_applied" }
  | { action: "fail"; reason: string };

/**
 * workflowの「適用した」報告を、サーバーが取り直した観測と照合する。**報告内容は信じず、観測だけで決める。**
 * - 未完了の要求でなければ何もしない（再送・遅延した報告・期限切れ後の報告で状態を戻さない）
 * - 初回はheadが固定したdevelopのSHAそのものであること（版上げ・範囲外のコミットを混ぜない）
 * - 2回目以降は直前のheadから早送りできていること（書き換え・巻き戻しをしない）
 */
export function decideRcReport(input: {
  row: { status: RcRevisionStatus; revision: number; expectedHeadSha: string | null; reason: RcRevisionReason };
  frozenDevelopSha: string;
  observation: RcReportObservation;
}): RcReportDecision {
  const { row, observation } = input;
  if (row.status === "applied") return { action: "ignore", reason: "already_applied" };
  if (row.status !== "requested") return { action: "ignore", reason: "not_pending" };
  const pr = observation.pullRequest;
  if (pr === null) return { action: "fail", reason: "候補のPRが見つかりません" };
  // 旧方式からの移行も「版を上げる前の固定点」そのものから作る
  if (row.reason === "initial" || row.reason === "migration") {
    if (pr.headSha !== input.frozenDevelopSha) {
      return { action: "fail", reason: `候補のheadが固定したdevelop（${input.frozenDevelopSha.slice(0, 7)}）と一致しません` };
    }
  } else {
    if (row.expectedHeadSha !== null && pr.headSha === row.expectedHeadSha) {
      return { action: "fail", reason: "候補ブランチが更新されていません" };
    }
    if (!observation.fastForward) {
      return { action: "fail", reason: "候補ブランチが直前のrevisionから早送りになっていません（履歴の書き換え・巻き戻し）" };
    }
  }
  return { action: "apply", prNumber: pr.number, baseSha: pr.baseSha, headSha: pr.headSha };
}

// ---------------------------------------------------------------------------
// 旧方式の識別と移行

export type LegacyMigrationDecision =
  | { ok: true; freezeSha: string }
  | { ok: false; reason: "not_bump_commit" | "merge_head" };

/**
 * 旧方式の候補（`release-main/vX.Y.Z`）を新方式へ移す起点を決める。旧方式の凍結点はバンプPRのhead
 * （developの固定点＋`vX.Y.Zをリリースする。`の1コミット）なので、その親が「版を上げる前の固定点」になる。
 * headがバンプのコミットでない（作り直し・履歴修復で積まれた）候補は移行せず、旧方式のまま完了させる
 * （推測で固定点を決めない）
 */
export function decideLegacyMigration(head: { message: string; parents: readonly string[] }): LegacyMigrationDecision {
  if (head.parents.length !== 1) return { ok: false, reason: "merge_head" };
  if (!/^v\d+\.\d+\.\d+.*をリリースする。/.test(head.message.split("\n")[0] ?? "")) return { ok: false, reason: "not_bump_commit" };
  return { ok: true, freezeSha: head.parents[0] };
}

export const LEGACY_MIGRATION_PROBLEM_LABEL: Record<"not_bump_commit" | "merge_head", string> = {
  not_bump_commit: "候補の先端が版上げのコミットではないため、版を上げる前の固定点を特定できません。旧方式のまま完了させてください",
  merge_head: "候補の先端がマージコミットのため、版を上げる前の固定点を特定できません。旧方式のまま完了させてください",
};

// ---------------------------------------------------------------------------
// 共有workflow（caller）の対応

export type RcCallerSupport =
  | { supported: true }
  | { supported: false; reason: "caller_unreadable" | "caller_without_input" };

export const RC_CALLER_REASON_LABEL: Record<"caller_unreadable" | "caller_without_input", string> = {
  caller_unreadable: "リリースworkflowのcallerを読めないため、旧方式で動作します",
  caller_without_input:
    "このリポジトリのリリースworkflowは候補管理（candidate_request）に対応していないため、旧方式で動作します。共有workflowの参照タグとcallerを対応版へ上げると切り替わります",
};

/**
 * callerの本文（developの`.github/workflows/release-develop-to-main.yml`）が候補管理に対応しているか。
 * 世代を表す専用の印は無いので、既存の`rebuild_selection`（#4335）と同じく**必要なinputの有無**で決める。
 * dispatchの`candidate_request`と、reusableへの受け渡し`candidate-request:`の両方が要る
 */
export function parseRcCallerSupport(text: string | null): RcCallerSupport {
  if (text === null) return { supported: false, reason: "caller_unreadable" };
  if (/^\s+candidate_request:/m.test(text) && text.includes("candidate-request:")) return { supported: true };
  return { supported: false, reason: "caller_without_input" };
}

// ---------------------------------------------------------------------------
// workflowへ渡す要求と、公開準備（#4496）へ渡す契約

/** workflowの`candidate_request` inputへ渡すJSON。workflowは値を検証し直してから使う */
export type RcWorkflowRequest = {
  candidate: string;
  sequence: number;
  revision: number;
  requestKey: string;
  /** 初回: developの固定SHA。更新: 直前revisionのhead */
  baseHeadSha: string;
  mode: "create" | "import";
  /** 更新で足すPR（developへのマージコミット）。developへのマージ順 */
  prs: { number: number; mergeSha: string }[];
};

export function serializeRcWorkflowRequest(request: RcWorkflowRequest): string {
  return JSON.stringify(request);
}

/**
 * 公開準備（正式バンプ・最終検証。#4496）へ渡す契約。**現在revisionが合格しているときだけ作れる。**
 * 公開準備はこの値（候補ID・revision・head/base・含めるPR）を固定の入力として扱い、developの最新を取り込まない
 */
export type RcFinalizeContract = {
  candidateId: string;
  sequence: number;
  revision: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  frozenDevelopSha: string;
  /** 固定時のPRと、取り込んだPR（関連修正・承認済み）の番号 */
  includedPrs: number[];
};

export function buildRcFinalizeContract(input: {
  candidate: { id: string; sequence: number; frozenDevelopSha: string; frozenPrNumbers: readonly number[] };
  current: { revision: number; prNumber: number | null; baseSha: string | null; headSha: string | null; importedPrNumbers: readonly number[] } | null;
  status: RcStatus;
}): RcFinalizeContract | null {
  const { current } = input;
  if (input.status !== "ready_to_prepare" || current === null) return null;
  if (current.prNumber === null || current.baseSha === null || current.headSha === null) return null;
  return {
    candidateId: input.candidate.id,
    sequence: input.candidate.sequence,
    revision: current.revision,
    prNumber: current.prNumber,
    baseSha: current.baseSha,
    headSha: current.headSha,
    frozenDevelopSha: input.candidate.frozenDevelopSha,
    includedPrs: [...new Set([...input.candidate.frozenPrNumbers, ...current.importedPrNumbers])],
  };
}

/** 要求キー。画面が操作ごとに生成し、再送では同じ値を送る（初回revisionは`<キー>:1`を使うので48文字まで） */
export function parseRcRequestKey(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,48}$/.test(value) ? value : null;
}

/** 表示用の候補ID */
export function rcLabel(sequence: number): string {
  return `RC-${sequence}`;
}

/** 新しい候補の開始を妨げる既存候補の区分（#4628） */
export type RcBlockKind =
  /** 通常の進行中。既存の候補を進める */
  | "in_progress"
  /** PRはmainへマージ済みなのに内部段階がレビューのまま、公開準備の記録がない等。実ジョブが無く、待っても進まない */
  | "inconsistent"
  /** 本番へ公開済みだが稼働確認が止まっている（#4712）。原因を直して確かめ直す。証拠未設定なら次の候補で確かめられる */
  | "production_stopped";

/** 開始前の画面に出す、既存候補の要約。画面・APIが同じ判定を使う */
export type RcBlockSummary = {
  candidateId: string;
  label: string;
  sequence: number;
  prNumber: number | null;
  phase: RcPhase;
  statusLabel: string;
  kind: RcBlockKind;
  /** 開始できない理由（1〜2文） */
  reason: string;
  /** 確認した事実 */
  facts: string[];
  /** 確認できていないこと（合格・公開完了を推測しない） */
  unconfirmed: string[];
  /** 管理記録の終了（取消）を提示してよいか。mainへマージ後（deploying以降）は不可 */
  cancellable: boolean;
  /** 稼働確認が止まっている（#4712）なら、その理由 */
  productionStopReason?: ProductionStopReason | null;
  /** 次にできる操作（1文）。稼働確認の停止で使う */
  action?: string;
  /**
   * 証拠未設定の候補を残したまま、次の候補を始められるか（`decideSuccessorStart`）。始められる場合の開始は、
   * この候補を後続の確認待ちへ移して行う（完了・取消にはしない）
   */
  successorStart?: { allowed: true } | { allowed: false; reason: string };
};

/**
 * 既存候補が新規開始を妨げる理由を分類する。**マージ済みだけで検証合格・公開完了とは扱わない。**
 * 不整合は「内部段階がレビューのままなのに、候補のPRがmainへマージ済み」に限る
 * （レビュー段階からマージへは公開準備を経由するので、実ジョブも公開準備の記録も無いまま届く経路が無い）
 */
export function classifyRcBlock(input: {
  candidateId: string;
  sequence: number;
  prNumber: number | null;
  phase: RcPhase;
  status: RcStatus;
  statusLabel: string;
  /** 稼働確認の停止理由（#4712）。止まっていなければnull */
  productionStopReason?: ProductionStopReason | null;
  /** 停止の理由・次の操作（`deriveRcStatus`の理由文） */
  statusReason?: string;
}): RcBlockSummary {
  const label = `RC-${input.sequence}`;
  const base = {
    candidateId: input.candidateId,
    label,
    sequence: input.sequence,
    prNumber: input.prNumber,
    phase: input.phase,
    statusLabel: input.statusLabel,
    cancellable: canCancelRc(input.phase),
  };
  const prText = input.prNumber === null ? "候補のPR" : `PR #${input.prNumber}`;
  if (input.status === "production_stopped" && input.productionStopReason) {
    const text = PRODUCTION_STOP_TEXT[input.productionStopReason];
    return {
      ...base,
      kind: "production_stopped",
      productionStopReason: input.productionStopReason,
      reason: `${prText}は本番へ公開済みですが、稼働確認が止まっています（${text.label}）。${text.cause}。`,
      facts: [`${prText}はmainへマージ済み`, `現在の工程: ${input.statusLabel}`],
      unconfirmed: ["本番の稼働版（確かめるまでこの候補は完了にせず、版の予約・候補の枠も保ちます）"],
      action: input.statusReason ?? text.action,
    };
  }
  if (input.phase === "review" && input.status === "deploying") {
    return {
      ...base,
      kind: "inconsistent",
      reason: "候補の管理記録が残っています。実際に進行している本番反映や検証はありません。",
      facts: [`${prText}はmainへマージ済み`, "内部段階は「レビュー」のまま", "公開準備の記録なし・実行中のジョブなし"],
      unconfirmed: ["本番の稼働版", "検証の合否（マージ済みだけでは合格・公開完了と扱いません）"],
    };
  }
  return {
    ...base,
    kind: "in_progress",
    reason: "進行中のリリース候補があります。新しい候補は作らず、この候補を進めてください。",
    facts: [prNumberFact(input.prNumber), `現在の工程: ${input.statusLabel}`],
    unconfirmed: [],
  };
}

function prNumberFact(prNumber: number | null): string {
  return prNumber === null ? "候補のPRはまだありません" : `関連PR: #${prNumber}`;
}
