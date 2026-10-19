import { compareVersions, nextVersion, type BumpKind } from "@/lib/semver-bump";
import type { ReleaseVerificationKind, ReleaseVerificationRecord, ReleaseVerificationView } from "@/lib/release-merge-gate";
import {
  describeReviewStageLabel,
  REVIEW_OPEN_ITEM_LABEL,
  type ReviewEvidenceStage,
} from "@/lib/release-review-reevaluation";

/**
 * 公開準備（#4496）の判断。**合格した候補（#4495）だけを、公開の直前に正式バンプする。**
 * 外部操作（GitHub・DB）は`release-finalize-run.ts`が持ち、ここは純関数だけにする。
 *
 * - 版は`ReleaseVersionReservation`で予約する。公開前の再試行・失敗では同じ版を保ち、増やさない。
 *   mainへ入った版・タグの付いた版は消費済みで、変更内容の違う再公開をしない
 * - バンプ前の検証（revisionのhead）とバンプ後の対象は別に持つ。引継ぎは元の結果と差分の根拠を残し、
 *   旧SHAの結果を新SHAの実行結果へ書き換えない
 */

// ---------------------------------------------------------------------------
// 状態

/** 公開準備1回の記録状態。`applied`はバンプ後のheadを記録した状態（最終CI・ビルドの合否は別に見る） */
export type FinalizeStatus = "requested" | "applied" | "failed" | "expired" | "superseded";

export const FINALIZE_STATUS_LABEL: Record<FinalizeStatus, string> = {
  requested: "バンプ中",
  applied: "バンプ済み",
  failed: "失敗",
  expired: "期限切れ",
  superseded: "置き換え済み",
};

/** 結果を受け取れないまま要求を残しておく時間。過ぎたら`expired`にしてやり直せるようにする */
export const FINALIZE_TTL_MS = 2 * 60 * 60 * 1000;

export function isFinalizePendingExpired(row: { status: string; createdAt: Date }, now: Date): boolean {
  return row.status === "requested" && now.getTime() - row.createdAt.getTime() >= FINALIZE_TTL_MS;
}

/** 版予約の状態。`reserved`＝未公開で保持中、`released`＝公開せずに手放した、`consumed`＝mainへ入った（再利用しない） */
export type VersionReservationStatus = "reserved" | "released" | "consumed";

// ---------------------------------------------------------------------------
// 版の予約

export type VersionReservationRow = {
  version: string;
  candidateId: string;
  status: VersionReservationStatus;
};

export type VersionReservationDecision =
  /** この候補が既に予約している版を使い続ける（再試行・失敗後のやり直しで増やさない） */
  | { action: "reuse"; version: string }
  /** 新しく予約する。`release`はこの候補が保持していて手放す古い予約（上げ幅の変更・mainの前進） */
  | { action: "reserve"; version: string; release: string[]; skipped: string[] }
  | { action: "conflict"; version: string; reason: "reserved_by_other" | "unreadable_main_version" };

/**
 * 予約する版を決める。**起点は常にmainの版**で、developの版は見ない
 * （公開後のdevelopは古い版のままなので、それを起点にすると既に公開した版を「バンプ済み」と誤判定する）。
 *
 * - 起点から上げ幅で計算した版が、タグ・消費済みの予約にあれば欠番にして次のpatchへ進める（上書きしない）
 * - 他の候補が`reserved`で持っている版は取らない（同時候補の競合。`conflict`）
 * - この候補が同じ版を`reserved`で持っていれば`reuse`。違う版を持っていれば手放して取り直す
 */
export function decideVersionReservation(input: {
  candidateId: string;
  mainVersion: string | null;
  bumpKind: BumpKind;
  /** 既存のタグ（`v1.2.3`形式。ブランチ・リリースの有無を問わない） */
  existingTags: readonly string[];
  reservations: readonly VersionReservationRow[];
}): VersionReservationDecision {
  const base = nextVersion(input.mainVersion, input.bumpKind);
  if (base === null) return { action: "conflict", version: "", reason: "unreadable_main_version" };

  const tags = new Set(input.existingTags.map((tag) => tag.replace(/^v/, "")));
  const consumed = new Set(input.reservations.filter((r) => r.status === "consumed").map((r) => r.version));
  const heldByOther = new Set(
    input.reservations.filter((r) => r.status === "reserved" && r.candidateId !== input.candidateId).map((r) => r.version),
  );
  const own = input.reservations.filter((r) => r.status === "reserved" && r.candidateId === input.candidateId).map((r) => r.version);

  let version = base;
  const skipped: string[] = [];
  // 消費済み・タグ済みの版は欠番にして、次のpatchへ進める（無限に回らないよう上限を置く）
  for (let i = 0; i < 50 && (tags.has(version) || consumed.has(version)); i++) {
    skipped.push(version);
    version = nextVersion(version, "patch") ?? version;
  }
  if (heldByOther.has(version)) return { action: "conflict", version, reason: "reserved_by_other" };
  if (own.includes(version)) return { action: "reuse", version };
  return { action: "reserve", version, release: own, skipped };
}

/**
 * 候補の先端の版が「この候補の予約版でバンプ済み」か。**mainの版より新しく、かつ予約した版と一致するときだけ**。
 * developに残った古い版（mainより古い・同じ）や、他の候補の版を「バンプ済み」と読まない
 */
export function isBumpedToReservation(input: { headVersion: string | null; mainVersion: string | null; reservedVersion: string }): boolean {
  if (!input.headVersion || !input.mainVersion) return false;
  const ahead = compareVersions(input.headVersion, input.mainVersion);
  return ahead !== null && ahead > 0 && compareVersions(input.headVersion, input.reservedVersion) === 0;
}

/**
 * 手放してよい予約か。**消費済みは手放さない。** タグ・main上の版が既にあれば、公開済みとして消費に回す
 */
export function decideReservationRelease(input: {
  status: VersionReservationStatus;
  version: string;
  existingTags: readonly string[];
  mainVersion: string | null;
}): "release" | "consume" | "keep" {
  if (input.status === "consumed") return "keep";
  const tagged = input.existingTags.some((tag) => tag.replace(/^v/, "") === input.version);
  const onMain = input.mainVersion !== null && compareVersions(input.mainVersion, input.version) !== null && compareVersions(input.mainVersion, input.version)! >= 0;
  if (tagged || onMain) return "consume";
  return input.status === "reserved" ? "release" : "keep";
}

// ---------------------------------------------------------------------------
// 差分の分類と、検証の引継ぎ

export type ChangedFileCategory = "version" | "changelog" | "ios_version" | "dependency" | "other";

export type FinalizePathRules = {
  /** `version-file`（既定package.json）。その階層のロックファイルも版の書き換えとして扱う */
  versionFile: string;
};

const CHANGELOG_PATTERN = /(^|\/)(changelog|release-notes|updates?-history)[^/]*$|^\.github\/release-notes\.md$/i;
const IOS_VERSION_PATTERN = /(^|\/)(Info\.plist|project\.pbxproj|[^/]*\.xcconfig)$/;
const DEPENDENCY_PATTERN = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|Podfile\.lock|Package\.resolved|Gemfile\.lock|poetry\.lock|requirements[^/]*\.txt)$/;

/** バンプで変わったファイル1件を分類する。分類できないものは`other`（引継ぎの根拠にしない） */
export function categorizeChangedFile(path: string, rules: FinalizePathRules): ChangedFileCategory {
  const versionDir = rules.versionFile.includes("/") ? rules.versionFile.slice(0, rules.versionFile.lastIndexOf("/") + 1) : "";
  if (path === rules.versionFile || path === `${versionDir}package-lock.json` || path === `${versionDir}npm-shrinkwrap.json`) return "version";
  if (DEPENDENCY_PATTERN.test(path)) return "dependency";
  if (IOS_VERSION_PATTERN.test(path)) return "ios_version";
  if (CHANGELOG_PATTERN.test(path)) return "changelog";
  return "other";
}

const IOS_VERSION_LINE = /^\s*(MARKETING_VERSION|CURRENT_PROJECT_VERSION)\s*=\s*"?([^";\s]+)"?\s*;?\s*$/;

/**
 * iOS設定ファイルのpatchが、版番号の行（`MARKETING_VERSION`・`CURRENT_PROJECT_VERSION`）の書き換えだけか（#4753）。
 * 削除行と追加行が同じキーの並びで対になり、追加後の`MARKETING_VERSION`が予約済みの正式版と一致するときだけtrue。
 * patchが無い（巨大差分）・他の行が変わる場合はfalse
 */
export function isIosVersionLinesOnlyPatch(patch: string | null | undefined, expectedVersion: string): boolean {
  if (!patch) return false;
  const removed: [string, string][] = [];
  const added: [string, string][] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\") || line === "") continue;
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    const m = IOS_VERSION_LINE.exec(line.slice(1));
    if (!m) return false;
    (sign === "-" ? removed : added).push([m[1], m[2]]);
  }
  if (removed.length === 0 || removed.length !== added.length) return false;
  return added.every(([key, value], i) => {
    if (removed[i][0] !== key) return false;
    return key === "MARKETING_VERSION" ? value === expectedVersion : /^\d+$/.test(value);
  });
}

export type BumpDiffSummary = {
  /** `versionLinesOnly`: `ios_version`のファイルで、差分が版番号の行の書き換えだけ（公開承認の範囲内。#4753） */
  files: { path: string; category: ChangedFileCategory; versionLinesOnly?: boolean }[];
  /** 版ファイルが実際に変わっているか（効いていないバンプを適用済みにしない） */
  versionFileChanged: boolean;
  /** 版・更新履歴以外（iOS設定・依存関係・その他）に触れているか。`true`なら引継ぎの前提が変わる */
  touchesBeyondVersion: boolean;
};

export function summarizeBumpDiff(paths: readonly string[], rules: FinalizePathRules, versionLinesOnlyPaths: ReadonlySet<string> = new Set()): BumpDiffSummary {
  const files = [...new Set(paths)].sort().map((path) => {
    const category = categorizeChangedFile(path, rules);
    return category === "ios_version" && versionLinesOnlyPaths.has(path) ? { path, category, versionLinesOnly: true } : { path, category };
  });
  return {
    files,
    versionFileChanged: files.some((f) => f.path === rules.versionFile),
    touchesBeyondVersion: files.some((f) => f.category !== "version" && f.category !== "changelog"),
  };
}

/** 引継ぎを判定する検証の種別。iOS検証は設定のあるリポジトリだけ（`ios`）。 */
export type FinalizeVerificationKind = ReleaseVerificationKind | "ios";

export type InheritanceDecision = {
  kind: FinalizeVerificationKind;
  action: "inherit" | "rerun";
  reason: string;
};

export const INHERITANCE_REASON_LABEL = {
  not_passed_before: "バンプ前の結果が合格ではないため引き継げません",
  main_advanced: "バンプ前の検証以降にmainが進んだため、再検証します",
  unverified_scope: "バンプ前の結果に未確認の範囲があるため、再検証します",
  beyond_version: "版・更新履歴以外のファイルが変わったため、再検証します",
  ios_files_changed: "iOSの設定・依存関係が変わったため、iOS検証を再実行します",
  ios_final_required: "このリポジトリはiOS検証が必要なため、バンプ後のheadで最終検証を再実行します",
  version_and_changelog_only: "バンプで変わったのは版と更新履歴だけのため、バンプ前の合格を引き継ぎます",
  version_lines_only: "バンプで変わったのは版・更新履歴とiOS設定の版番号行だけのため、バンプ前の合格を引き継ぎます",
} as const;

/**
 * 全体レビュー・統合検証にとって「版の書き換えだけ」と見なせるファイルか（#4764）。
 * `ios_version`は、版番号の行だけが予約済みの正式版へ書き換わったと確かめたもの（`versionLinesOnly`）に限る
 */
function isVersionOnlyForReview(file: BumpDiffSummary["files"][number]): boolean {
  return file.category === "version" || file.category === "changelog" || (file.category === "ios_version" && file.versionLinesOnly === true);
}

/**
 * バンプ前の合格を、バンプ後のheadへ引き継げるか。**安全だと判定できなければ再検証する。**
 * 引き継ぐのは「版ファイル（と同じ階層のロック）・更新履歴だけが変わった」場合に限り、lifecycleがコード・設定を
 * 変えたとき（iOS設定・依存関係・その他）は影響する検証を再実行する。
 * 全体レビュー・統合検証に限り、iOS設定の版番号行だけの書き換え（`versionLinesOnly`）も版と同じ扱いにする（#4764）。
 * iOS検証はiOS設定が変われば従来どおり再実行する
 */
export function decideInheritedVerification(input: {
  kind: FinalizeVerificationKind;
  /** バンプ前（revisionのhead）で記録された結果。無ければnull */
  before: { state: string; baseSha: string; headSha: string; unverifiedScope?: string | null } | null;
  /** バンプ前の検証対象のbase。現在のbaseと違えばmainが進んでいる */
  currentBaseSha: string;
  diff: BumpDiffSummary;
  /**
   * このリポジトリがiOS検証を必要とするか。Mac検証は統合検証の工程の1つなので、必要なら統合検証は
   * バンプ後のheadで必ず再実行する（iOSの版情報・build番号を最終headで確かめる）
   */
  requireFreshIos?: boolean;
}): InheritanceDecision {
  const { kind, before, diff } = input;
  const rerun = (reason: keyof typeof INHERITANCE_REASON_LABEL): InheritanceDecision => ({ kind, action: "rerun", reason: INHERITANCE_REASON_LABEL[reason] });
  if (before === null || before.state !== "passed") return rerun("not_passed_before");
  if (before.unverifiedScope?.trim()) return rerun("unverified_scope");
  if (before.baseSha !== input.currentBaseSha) return rerun("main_advanced");
  if (input.requireFreshIos && (kind === "integration" || kind === "ios")) return rerun("ios_final_required");
  if (diff.touchesBeyondVersion) {
    if (kind !== "ios" && diff.files.every(isVersionOnlyForReview)) {
      return { kind, action: "inherit", reason: INHERITANCE_REASON_LABEL.version_lines_only };
    }
    const iosOnlyAffected = diff.files.every((f) => f.category === "version" || f.category === "changelog" || f.category === "ios_version" || f.category === "dependency");
    if (kind === "ios" && iosOnlyAffected) return rerun("ios_files_changed");
    return rerun("beyond_version");
  }
  return { kind, action: "inherit", reason: INHERITANCE_REASON_LABEL.version_and_changelog_only };
}

/** 引継ぎの証跡1件。**元の結果（SHA・状態）と差分の根拠を残し、新しいSHAで実行したとは書かない** */
export type InheritanceEvidence = InheritanceDecision & {
  fromBaseSha: string;
  fromHeadSha: string;
  toBaseSha: string;
  toHeadSha: string;
  files: string[];
  decidedAt: string;
};

export function buildInheritanceEvidence(input: {
  decision: InheritanceDecision;
  from: { baseSha: string; headSha: string };
  to: { baseSha: string; headSha: string };
  diff: BumpDiffSummary;
  now: Date;
}): InheritanceEvidence {
  return {
    ...input.decision,
    fromBaseSha: input.from.baseSha,
    fromHeadSha: input.from.headSha,
    toBaseSha: input.to.baseSha,
    toHeadSha: input.to.headSha,
    files: input.diff.files.map((f) => f.path),
    decidedAt: input.now.toISOString(),
  };
}

/** 検証記録（バンプ後の対象に派生した引継ぎ分）。`inheritedFromHeadSha`があれば画面は「引継ぎ」と出す */
export type InheritedVerification<R> = R & { inheritedFromHeadSha: string };

/**
 * 引継ぎの証跡と元の結果から、バンプ後の対象に対する**派生の記録**を作る。DBの検証行は書き換えない
 * （元の行はバンプ前のSHAのまま残る）。元の結果が今も合格であること・SHAが証跡と一致することを毎回確かめる。
 * 元の記録の内容（要約・証跡URLなど）はそのまま引き継ぎ、SHAだけを差し替える
 */
export function deriveInheritedRecords<R extends ReleaseVerificationRecord>(input: {
  finalization: { status: FinalizeStatus; evidence: readonly InheritanceEvidence[] };
  originals: readonly R[];
}): InheritedVerification<R>[] {
  // 証跡はバンプを適用した時点で初めて書かれる（要求中・期限切れの記録には無い）。後から最終検証が失敗して
  // 修正工程へ戻った記録でも、バンプ後のheadに対する引継ぎの事実は変わらない
  if (input.finalization.status === "requested" || input.finalization.status === "expired") return [];
  return input.finalization.evidence.flatMap((e) => {
    if (e.action !== "inherit" || e.kind === "ios") return [];
    const original = input.originals.find(
      (r) => r.kind === e.kind && r.baseSha === e.fromBaseSha && r.headSha === e.fromHeadSha && r.state === "passed" && !r.unverifiedScope?.trim(),
    );
    if (!original) return [];
    return [{ ...original, baseSha: e.toBaseSha, headSha: e.toHeadSha, inheritedFromHeadSha: e.fromHeadSha }];
  });
}

/** 引継ぎの証跡（JSON列）を読む。形が違う要素は捨てる（読めないものを引継ぎの根拠にしない） */
export function parseInheritanceEvidence(value: unknown): InheritanceEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const e = item as Partial<InheritanceEvidence> | null;
    if (!e || typeof e !== "object") return [];
    const ok =
      (e.kind === "ai_review" || e.kind === "integration" || e.kind === "ios") &&
      (e.action === "inherit" || e.action === "rerun") &&
      typeof e.reason === "string" &&
      typeof e.fromBaseSha === "string" &&
      typeof e.fromHeadSha === "string" &&
      typeof e.toBaseSha === "string" &&
      typeof e.toHeadSha === "string";
    return ok ? [{ ...(e as InheritanceEvidence), files: Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === "string") : [] }] : [];
  });
}

// ---------------------------------------------------------------------------
// 公開準備を始めてよいか

export type FinalizeStartInput = {
  /** `buildRcFinalizeContract`の結果。公開準備可能でなければnull */
  contract: { candidateId: string; revision: number; prNumber: number; baseSha: string; headSha: string; requiresAiReviewWaiver?: boolean } | null;
  phase: string;
  /** 候補の先端・mainの先端（GitHubから取り直した現在） */
  observed: { prHeadSha: string; prBaseSha: string; mainSha: string | null } | null;
  /** 未完了の公開準備があるか */
  hasPending: boolean;
  /** 画面で見ていた候補のhead（押した時点の先端） */
  expectedHeadSha: string;
  /** 全体レビューの結果を承知で公開へ進むと、人が確認画面で明示したか（#4807）。省略時はfalse */
  waiveAiReview?: boolean;
};

export type FinalizeStartDecision =
  | {
      ok: true;
      contract: NonNullable<FinalizeStartInput["contract"]>;
      /** 全体レビューを止める条件から外して公開準備を始めるか（合格していない全体レビューを、人が承知で外した） */
      aiReviewWaived: boolean;
    }
  | {
      ok: false;
      error: "not_ready" | "wrong_phase" | "candidate_changed" | "main_advanced" | "in_progress" | "unobserved" | "ai_review_waiver_required";
    };

export const FINALIZE_START_ERROR_LABEL: Record<Exclude<FinalizeStartDecision, { ok: true }>["error"], string> = {
  not_ready: "全体レビュー・統合検証に合格していないため、公開準備を始められません",
  wrong_phase: "この候補は公開準備を始められる段階ではありません",
  candidate_changed: "候補が更新されています。最新の状態を確かめてからやり直してください",
  main_advanced: "mainが進んでいるため、検証を取り直すまで公開準備を始められません",
  in_progress: "公開準備が進行中です",
  unobserved: "候補の現在の状態を取得できませんでした",
  ai_review_waiver_required: "全体レビューが合格していません。結果を確かめ、承知で進むことを明示してから押してください",
};

/**
 * 公開準備（正式バンプ）を始めてよいか。**レビュー・修正中は始めない**（契約が作れるのは合格のときと、
 * 止めているのが全体レビューだけのとき）。後者は人の明示（`waiveAiReview`）が無ければ受け付けない（#4807）。
 * 押した時点の候補の先端（`expectedHeadSha`）・現在のGitHubの先端・検証したbaseの3つが一致しなければ受け付けない
 */
export function decideFinalizeStart(input: FinalizeStartInput): FinalizeStartDecision {
  if (input.phase !== "review") return { ok: false, error: "wrong_phase" };
  if (input.hasPending) return { ok: false, error: "in_progress" };
  if (input.contract === null) return { ok: false, error: "not_ready" };
  if (input.observed === null || input.observed.mainSha === null) return { ok: false, error: "unobserved" };
  if (input.observed.prHeadSha !== input.contract.headSha || input.expectedHeadSha !== input.contract.headSha) {
    return { ok: false, error: "candidate_changed" };
  }
  if (input.observed.prBaseSha !== input.contract.baseSha || input.observed.mainSha !== input.contract.baseSha) {
    return { ok: false, error: "main_advanced" };
  }
  const aiReviewWaived = input.contract.requiresAiReviewWaiver === true;
  if (aiReviewWaived && input.waiveAiReview !== true) return { ok: false, error: "ai_review_waiver_required" };
  return { ok: true, contract: input.contract, aiReviewWaived };
}

// ---------------------------------------------------------------------------
// workflowの報告の照合

export type FinalizeReportObservation = {
  /** 候補ブランチのPR（GitHubから取り直す）。無ければnull */
  pullRequest: { number: number; baseSha: string; headSha: string; draft: boolean } | null;
  /** バンプ前のhead（`preHeadSha`）が現在のheadの祖先か */
  fastForward: boolean;
  /** バンプ前headから現在のheadまでの変更ファイル */
  changedFiles: readonly string[];
  /** 変更ファイルごとのpatch（取れなかった・巨大なものは含まない。#4753） */
  patches?: Readonly<Record<string, string>>;
  /** 現在のheadの版（版ファイルを`version-query`で読んだもの。読めなければnull） */
  headVersion: string | null;
  mainVersion: string | null;
};

export type FinalizeReportDecision =
  | { action: "apply"; prNumber: number; baseSha: string; headSha: string; diff: BumpDiffSummary; version: string }
  | { action: "ignore"; reason: "not_pending" | "already_applied" }
  | { action: "wait"; reason: string }
  | { action: "fail"; reason: string };

/**
 * workflowの「バンプした」報告を、サーバーが取り直した観測と照合する。**報告内容は信じず、観測だけで決める。**
 * 候補の先端がバンプ前headから早送りになっており、版ファイルが「要求で予約した版」（自動判定のときは
 * 判定結果から決めた版`expectedVersion`）へ書き換わっているときだけ適用する
 */
export function decideFinalizeReport(input: {
  row: { status: FinalizeStatus; preHeadSha: string };
  /** 版の確定値。手動指定は要求時の予約、自動判定はworkflowが報告した上げ幅から`decideVersionReservation`で決めた版 */
  expectedVersion: string | null;
  rules: FinalizePathRules;
  observation: FinalizeReportObservation;
}): FinalizeReportDecision {
  const { row, observation } = input;
  if (row.status === "applied") return { action: "ignore", reason: "already_applied" };
  if (row.status !== "requested") return { action: "ignore", reason: "not_pending" };
  const pr = observation.pullRequest;
  if (pr === null) return { action: "fail", reason: "候補のPRが見つかりません" };
  if (pr.headSha === row.preHeadSha) {
    // 候補が既に予約した版でバンプ済み（修正工程から戻った再試行）なら、新しいコミットは作らずそのまま確定する。
    // 版を増やさず、同じheadの検証結果をそのまま使う
    if (
      input.expectedVersion !== null &&
      isBumpedToReservation({ headVersion: observation.headVersion, mainVersion: observation.mainVersion, reservedVersion: input.expectedVersion })
    ) {
      return { action: "apply", prNumber: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, diff: summarizeBumpDiff([], input.rules), version: input.expectedVersion };
    }
    return { action: "wait", reason: "候補ブランチがまだ更新されていません" };
  }
  if (!observation.fastForward) {
    return { action: "fail", reason: "候補ブランチがバンプ前のheadから早送りになっていません（履歴の書き換え・巻き戻し）" };
  }
  if (input.expectedVersion === null) return { action: "fail", reason: "版を確定できませんでした（上げ幅の報告がありません）" };
  const versionLinesOnly = new Set(
    observation.changedFiles.filter((path) => categorizeChangedFile(path, input.rules) === "ios_version" && isIosVersionLinesOnlyPatch(observation.patches?.[path], input.expectedVersion!)),
  );
  const diff = summarizeBumpDiff(observation.changedFiles, input.rules, versionLinesOnly);
  const bumped = isBumpedToReservation({ headVersion: observation.headVersion, mainVersion: observation.mainVersion, reservedVersion: input.expectedVersion });
  // 候補の元のdevelopが既に正式版へ上がっていた場合（自動判定の結果と一致）は、版ファイルが変わらなくてよい（#4798）。
  // リリースノートなど版以外だけが変わったコミットでも、headの版がmainより新しく予約どおりなら確定する
  if (!diff.versionFileChanged && !bumped) return { action: "fail", reason: "版ファイルが書き換わっていません" };
  if (!bumped) {
    return {
      action: "fail",
      reason: `候補の版（${observation.headVersion ?? "不明"}）が確定する版（${input.expectedVersion}）と一致しないか、mainの版（${observation.mainVersion ?? "不明"}）より新しくありません`,
    };
  }
  return { action: "apply", prNumber: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, diff, version: input.expectedVersion };
}

// ---------------------------------------------------------------------------
// 公開準備の完了と、公開前の失敗

export type FinalChecks = {
  ciState: "pending" | "success" | "failure" | "unknown";
  /** バンプ後のheadの`version-tag-check`を含む必須検査が全て成功しているか（`ciState`が成功ならtrue） */
  draft: boolean;
};

export type FinalizeReadiness =
  | { ready: true }
  | { ready: false; reason: "ci_pending" | "ci_failed" | "ci_unknown" | "required_reverify" | "draft" };

export const FINALIZE_READINESS_LABEL: Record<Exclude<FinalizeReadiness, { ready: true }>["reason"], string> = {
  ci_pending: "バンプ後の最終CI・ビルドを実行中です",
  ci_failed: "バンプ後の最終CI・ビルドが失敗しています",
  ci_unknown: "バンプ後の最終CI・ビルドの結果を取得できません",
  required_reverify: "バンプ後の再検証が完了していません",
  draft: "候補PRがまだdraftです",
};

/**
 * 公開準備が完了したか。**バンプ後のheadで最終CI・ビルドが成功し、再実行が必要な検証が全て合格している**ときだけ。
 * 引継ぎでバンプ前の合格を使った検証は、`pendingReverify`に入れない
 */
export function decideFinalizeReadiness(input: { checks: FinalChecks; pendingReverify: readonly FinalizeVerificationKind[] }): FinalizeReadiness {
  if (input.checks.ciState === "failure") return { ready: false, reason: "ci_failed" };
  if (input.checks.ciState === "pending") return { ready: false, reason: "ci_pending" };
  if (input.checks.ciState === "unknown") return { ready: false, reason: "ci_unknown" };
  if (input.pendingReverify.length > 0) return { ready: false, reason: "required_reverify" };
  return { ready: true };
}

/**
 * 公開準備中・本番承認待ちの候補PRがマージされていたときの扱い。**最終検証を経ていないマージを本番反映へ進めない**。
 * 記録した最終headのままで、そのheadの最終CI・再検証が合格しているときだけ進める（早いマージでも保証を落とさない）。
 * 進めないときは理由を画面へ残す（`wait`は実行中の検証を待つだけ、`hold`は人がやり直すか確かめるまで進まない）。
 * どちらも毎巡回で評価し直すので、CI・検証をやり直して合格すればそこから進む（mainへ入った後は修正工程へ戻せない）。
 * 合格を確かめようがない場合（別の内容のマージなど）は、人が候補を取り消して終える（`cancelReleaseRc`が版を消費済みにする）
 */
export type MergedCandidateDecision = { action: "advance" } | { action: "wait" | "hold"; reason: string };

export function decideMergedCandidate(input: {
  headMatches: boolean;
  readiness: FinalizeReadiness;
  /** バンプ後のheadで合格していない再検証の状態（`passed`・`not_applicable`以外） */
  reverifyStates: readonly ReleaseVerificationView["state"][];
}): MergedCandidateDecision {
  const pre = "最終検証の完了前に候補PRがマージされました";
  if (!input.headMatches) return { action: "hold", reason: "公開準備で記録した最終headと異なる内容がマージされたため、本番反映の追跡へ進めません" };
  if (input.reverifyStates.includes("failed") || (!input.readiness.ready && input.readiness.reason === "ci_failed")) {
    return { action: "hold", reason: "バンプ後の最終検証が失敗した内容がマージされたため、本番反映の追跡へ進めません。CI・検証をやり直して合格すれば進みます" };
  }
  // 実行中・順番待ちの検証と実行中のCIだけは、待てば結果が出る
  const settling = input.reverifyStates.every((s) => s === "running" || s === "waiting");
  if (!input.readiness.ready && input.readiness.reason === "ci_pending" && settling) return { action: "wait", reason: `${pre}。最終CIの結果を待っています` };
  if (input.readiness.ready) return { action: "advance" };
  // CI結果の取得失敗は一時的なことが多いので止めずに待つ（解消しなければ、人は候補の取り消しで終えられる）
  if (input.readiness.reason === "ci_unknown" && settling) return { action: "wait", reason: `${pre}。最終CIの結果を取得できていません` };
  if (input.readiness.reason === "required_reverify" && settling) return { action: "wait", reason: `${pre}。再検証の結果を待っています` };
  // 依頼の失敗（not_run）・要確認・失効は、待っても解消しない
  return { action: "hold", reason: `${pre}。最終CI・再検証の合格を確認できないため本番反映の追跡へ進めません。CI・検証をやり直して合格すれば進みます` };
}

// ---------------------------------------------------------------------------
// バンプ後の再検証の状態分類（#4640）

/** 画面が見出し・badge・主操作を決めるための、再検証の現在状態。**「再検証中」は実行中・待機のジョブがあるときだけ** */
export type ReverifyPhase = "done" | "running" | "waiting" | "failed" | "needs_check" | "not_run" | "invalidated";

export type ReverifyItem = {
  kind: ReleaseVerificationKind;
  label: string;
  state: ReleaseVerificationView["state"];
  /** 画面に出す理由（未完了・要確認・失敗のときだけ） */
  reason: string | null;
};

const REVERIFY_KIND_LABEL: Record<ReleaseVerificationKind, string> = { integration: "統合検証", ai_review: "全体レビュー" };

export const REVERIFY_PHASE_LABEL: Record<ReverifyPhase, string> = {
  done: "完了",
  running: "再検証中",
  waiting: "実行待ち",
  failed: "失敗",
  needs_check: "要確認で終了",
  not_run: "未実施",
  invalidated: "対象が変わりました",
};

/**
 * バンプ後の対象に対する検証の記録（`evaluateReleaseMergeGate`のviews）を、検証ごとの理由付きの項目へ直す。
 * `reviewStage`（#4664）を渡すと、全体レビューが統合検証の証跡を待つ・その証跡で再評価している間は
 * 「再検証中」（待てば進む）として扱い、要確認で終了とは見せない。自動再評価済みの要確認には残件を添える
 */
export function describeReverifyItems(
  views: readonly ReleaseVerificationView[],
  reviewStage?: ReviewEvidenceStage | null,
): ReverifyItem[] {
  return views.map((view) => {
    const label = REVERIFY_KIND_LABEL[view.kind];
    if (view.kind === "ai_review" && reviewStage) {
      if (
        reviewStage.kind === "integration_waiting" ||
        reviewStage.kind === "reevaluating" ||
        reviewStage.kind === "awaiting_integration"
      ) {
        return { kind: view.kind, label, state: "running", reason: `${label}: ${describeReviewStageLabel(reviewStage)}` };
      }
      if (reviewStage.kind === "needs_check" && reviewStage.autoReevaluated && view.state === "needs_check") {
        const items = reviewStage.items.map((item) => REVIEW_OPEN_ITEM_LABEL[item]).join("・");
        return {
          kind: view.kind,
          label,
          state: view.state,
          reason: `${label}: 自動再評価済み・対応／判断が必要${items ? `（${items}）` : ""}`,
        };
      }
    }
    const reason = (() => {
      switch (view.state) {
        case "passed":
        case "not_applicable":
          return null;
        case "running":
          return `${label}を実行中です`;
        case "waiting":
          return `${label}の実行を待っています`;
        case "not_run":
          return `${label}がまだ依頼されていません`;
        case "failed":
          return `${label}が失敗しています`;
        case "needs_check":
          return ("reason" in view && view.reason) || `${label}が要確認で終了しています（実行中のジョブはありません）`;
        case "invalidated":
          return "reason" in view ? view.reason : `${label}の対象が変わりました`;
      }
    })();
    return { kind: view.kind, label, state: view.state, reason };
  });
}

/** 検証全体の現在状態。失敗は待たずに伝え、次に実行中・待機（待てば結果が出る）、その後に終了済みの未完了を返す */
export function decideReverifyPhase(items: readonly ReverifyItem[]): ReverifyPhase {
  const states = items.map((i) => i.state);
  if (states.includes("failed")) return "failed";
  if (states.includes("running")) return "running";
  if (states.includes("waiting")) return "waiting";
  if (states.includes("needs_check")) return "needs_check";
  if (states.includes("not_run")) return "not_run";
  if (states.includes("invalidated")) return "invalidated";
  return "done";
}

/** 公開前の最終検証が失敗したときの扱い。**版の予約は保つ**（再試行だけを理由に正式版を増やさない） */
export type FinalizeFailureHandling = {
  /** 候補の段階を戻す先（同じ候補の修正工程） */
  returnPhase: "review";
  /** 予約を手放すか（公開前の失敗では保つ。mainへ入った版は消費済みで触れない） */
  keepReservation: boolean;
};

export function decideFinalizeFailureHandling(input: { merged: boolean }): FinalizeFailureHandling | null {
  // mainへ入った後の失敗は修正工程へ戻せない（本番復旧の系列が引き継ぐ）
  if (input.merged) return null;
  return { returnPhase: "review", keepReservation: true };
}

/** 要求キー（画面が操作ごとに生成し、再送では同じ値を送る）から、公開準備の要求キーを作る */
export function finalizeRequestKey(candidateId: string, preHeadSha: string): string {
  return `fin-${candidateId.replace(/[^A-Za-z0-9]/g, "").slice(0, 28)}-${preHeadSha.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// callerの対応と、リポジトリごとの版ファイルの設定

export type FinalizeCallerSupport =
  | { supported: true; versionFile: string; versionQuery: string; bumpCommand: boolean }
  | { supported: false; reason: "caller_unreadable" | "caller_without_input" };

export const FINALIZE_CALLER_REASON_LABEL: Record<"caller_unreadable" | "caller_without_input", string> = {
  caller_unreadable: "リリースworkflowのcallerを読めないため、公開準備を始められません",
  caller_without_input:
    "このリポジトリのリリースworkflowは公開準備（finalize_request）に対応していません。共有workflowの参照タグとcallerを対応版へ上げてください",
};

function readCallerInput(text: string, name: string): string | null {
  const match = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m").exec(text);
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, "").trim() || null;
}

/**
 * callerの本文が公開準備に対応しているか（`finalize_request`のinputと`finalize-request:`の受け渡しの両方が要る）と、
 * リポジトリ差異（`version-file`・`version-query`・`bump-command`の有無）を読む。
 * 書かれていなければreusableの既定（`package.json`・`.version`）
 */
export function parseFinalizeCallerSupport(text: string | null): FinalizeCallerSupport {
  if (text === null) return { supported: false, reason: "caller_unreadable" };
  if (!/^\s+finalize_request:/m.test(text) || !text.includes("finalize-request:")) return { supported: false, reason: "caller_without_input" };
  return {
    supported: true,
    versionFile: readCallerInput(text, "version-file") ?? "package.json",
    versionQuery: readCallerInput(text, "version-query") ?? ".version",
    bumpCommand: readCallerInput(text, "bump-command") !== null,
  };
}

/**
 * ファイルの内容から、`version-query`（`.version`・`.a.b`のような単純な経路）で版を読む。
 * 読めない式・JSONでないファイルはnull（呼び出し側は「バンプ済み」と判定しない）
 */
export function readVersionFromText(text: string | null, versionQuery: string): string | null {
  if (text === null || !/^\.[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(versionQuery)) return null;
  try {
    let value: unknown = JSON.parse(text);
    for (const key of versionQuery.slice(1).split(".")) {
      if (typeof value !== "object" || value === null) return null;
      value = (value as Record<string, unknown>)[key];
    }
    return typeof value === "string" && /^v?\d+\.\d+\.\d+/.test(value) ? value.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

/** workflowへ渡す要求。workflowは値を検証し直してから使う */
export type FinalizeWorkflowRequest = {
  candidate: string;
  sequence: number;
  revision: number;
  requestKey: string;
  /** バンプ前の候補のhead。候補ブランチがこれと違えば、書き換えずに止める */
  baseHeadSha: string;
  /**
   * 上げ幅の指定。`auto`ならworkflowが差分から判定する。手動指定のときは`version`（予約済みの版）も渡す
   */
  bumpKind: BumpKind | "auto";
  version: string | null;
  /** 使えない版（タグ・消費済み・他の候補が保持）。workflowは自動判定の結果がこれに当たれば次のpatchへ進める */
  unavailableVersions: string[];
};

export function serializeFinalizeWorkflowRequest(request: FinalizeWorkflowRequest): string {
  return JSON.stringify(request);
}
