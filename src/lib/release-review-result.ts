import { createHash } from "node:crypto";

import type { ReleaseVerificationState } from "@/lib/release-merge-gate";
import {
  RELEASE_REVIEW_CHECKLIST_VERSION,
  RELEASE_REVIEW_CHECK_ITEM_IDS,
  describeUnconfirmedChecks,
  normalizeCheckResults,
  type ReleaseReviewCheckResult,
  type ReleaseReviewCheckStatus,
} from "@/lib/release-review-checklist";
import { reviewFindingKey } from "@/lib/release-fix-series";

/**
 * リリース全体のAIレビュー（#4238）の結果の正規化。ランナーが報告した生の値を、記録できる形へ絞る。
 *
 * **AIのLGTMだけで「準備完了」にしない。** 指摘が1件でもある場合は`needs_check`、確認できなかった範囲が
 * ある場合は未確認範囲つきの`passed`（判定側が理由付きの`needs_check`へ読み替える）にし、どちらも
 * 既存の明示確認フローへ渡る。`failed`は
 * レビューを完走できなかったときだけ。
 */
export type ReleaseReviewFinding = {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  file: string | null;
  /** 該当行（分かるときだけ） */
  line: number | null;
  /** 利用者・本番への影響（#4300） */
  impact: string | null;
  /** 指摘の根拠（再現手順・該当コードなど） */
  evidence: string | null;
  /** 推奨する対応 */
  recommendation: string | null;
  /** 影響するPR番号 */
  pullRequests: number[];
  /**
   * 指摘の安定ID（`R-xxxxxx`・#4559）。保存した台帳は持たず、題・ファイル・行から都度導出する
   * （再発は前回のIDを引き継ぐ）。修正系列の項目（`ReleaseFixSeries.items`）も同じ関数で導出して突き合わせる
   */
  id?: string;
  /** 前回の指摘と同じものの再発か、新規か。前回の記録が無いレビューでは`new` */
  status?: "new" | "recurring";
  /** 新規指摘の発見理由。前回の記録がある再レビューだけ。観測できなければ`unknown` */
  discovery?: ReleaseReviewDiscovery | null;
  /** リリースを止めると判定した理由（実害・根拠）。止めない提案には付けない */
  blockingReason?: string | null;
  /** この指摘を確認した回数（再発のたびに増える） */
  occurrences?: number;
  /** 再発した指摘が解消されない原因の区分と、次の対応 */
  stallCause?: ReleaseReviewStallCause | null;
  /**
   * ユーザーが判断済みの指摘について、AIが判断の前提（対象差分・影響）が変わったと報告した理由（#4657）。
   * あれば判断は「再確認が必要」になる。前提の変化を示せない再提示ではこの値を付けない
   */
  premiseChanged?: string | null;
  /** AIが申告した、指摘が属する確認項目のID（`auth_boundary`はセキュリティ相当として止める指摘に固定する。#4765） */
  checkId?: string | null;
  /** 止める指摘の申告をサーバーが提案へ降格した理由（#4765）。降格していなければ付けない */
  demotedReason?: string | null;
};

export const RELEASE_REVIEW_DISCOVERIES = ["fix_induced", "initial_miss", "scope_added", "unknown"] as const;
export type ReleaseReviewDiscovery = (typeof RELEASE_REVIEW_DISCOVERIES)[number];
export const RELEASE_REVIEW_DISCOVERY_LABEL: Record<ReleaseReviewDiscovery, string> = {
  fix_induced: "修正由来",
  initial_miss: "初回の見落とし",
  scope_added: "対象追加",
  unknown: "発見理由は不明",
};

export const RELEASE_REVIEW_STALL_CAUSES = [
  "unfixed",
  "fix_ineffective",
  "verification_insufficient",
  "execution_failure",
  "unknown",
] as const;
export type ReleaseReviewStallCause = (typeof RELEASE_REVIEW_STALL_CAUSES)[number];
/** 同じ指摘が未解消のまま繰り返すときの原因と次の対応（継続の上限・停止は#4410/#4478の機構に従う） */
export const RELEASE_REVIEW_STALL_GUIDE: Record<ReleaseReviewStallCause, { label: string; next: string }> = {
  unfixed: { label: "未修正", next: "修正が指摘のファイルへ届いていません。修正Issueの対象と修正PRの内容を確認してください" },
  fix_ineffective: { label: "修正が効いていない", next: "修正後も同じ問題が残っています。修正方針を見直す判断が必要です" },
  verification_insufficient: { label: "検証不足", next: "解消を裏付ける根拠が足りません。再現手順や確認箇所を添えて再確認してください" },
  execution_failure: { label: "実行障害", next: "前回のレビュー実行が失敗しています。実行環境を直してから再実行してください" },
  unknown: { label: "原因未特定", next: "原因を特定できていません。指摘と修正差分を人が確認してください" },
};

/** 前回の指摘に対する今回の確認結果 */
export type PreviousFindingResolution = {
  id: string;
  title: string;
  status: "resolved" | "unresolved" | "not_checked";
  evidence: string | null;
};

/** 全体レビューの確認契約の記録（確認項目の版・種別・範囲・項目別の結果。#4559） */
export type ReleaseReviewMeta = {
  checklistVersion: number | null;
  /** 項目別の記録が無い旧ランナーの結果 */
  legacy: boolean;
  mode: "initial" | "rereview";
  /** 再レビューにできなかった・範囲を広げた理由。再レビューが成立したときはnull */
  fullReviewReason: string | null;
  /** 再レビューで再確認した範囲と選定理由 */
  recheckScope: string | null;
  previous: { prNumber: number; baseSha: string; headSha: string } | null;
  /** 前回の対象から今回までの修正差分のファイル数 */
  fixDiffFileCount: number | null;
  addedPullRequests: number[];
  checks: ReleaseReviewCheckResult[];
  previousFindings: PreviousFindingResolution[];
};

/** サーバーが前回の記録から作る、再レビューの文脈（`release-review-context.ts`）。正規化の入力 */
export type ReleaseReviewNormalizeContext = {
  /** 前回の記録を使える条件か（使えなければ全体確認） */
  mode: "initial" | "rereview";
  fullReviewReason: string | null;
  previous: {
    prNumber: number;
    baseSha: string;
    headSha: string;
    statuses: Record<string, ReleaseReviewCheckStatus>;
    runFailed: boolean;
  } | null;
  previousFindings: ReleaseReviewContextFinding[];
  /**
   * ユーザーが修正しないと判断した（公開後対応・見送り・不採用）、今のbaseで有効な指摘ID（#4657）。
   * 前回の指摘の解消確認・未解消の自動再注入の対象から外し、AIが前提の変化（`premiseChanged`）を申告できるのはこのIDだけ
   */
  decidedFindingIds?: string[];
};

export type ReleaseReviewContextFinding = {
  id: string;
  title: string;
  file: string | null;
  line: number | null;
  detail: string;
  occurrences: number;
};

/** 指摘の安定ID。既存の指摘キー（題・ファイル・行）のハッシュで、保存せず導出する */
export function reviewFindingId(finding: Pick<ReleaseReviewFinding, "title" | "file" | "line">): string {
  return `R-${createHash("sha1").update(reviewFindingKey(finding)).digest("hex").slice(0, 6)}`;
}

export type ReleaseReviewDetail = {
  /** リリースを止める指摘（旧形式の指摘もここ）。1件でもあれば`needs_check` */
  findings: ReleaseReviewFinding[];
  /** リリースを止めない改善提案。これだけでは候補を止めない */
  suggestions: ReleaseReviewFinding[];
  /** 確認契約の記録。旧形式の結果では`legacy`のメタが入る */
  review: ReleaseReviewMeta | null;
  affectedPullRequests: number[];
  affectedFiles: string[];
  /** 根拠つきで確認済みと判断できたファイル数。入力へ載せた数ではない。実績を確かめられない旧結果ではnull */
  reviewedFiles: number | null;
  totalFiles: number | null;
  /** ファイルごとの確認実績（#4615）。旧ランナーの結果ではnull（実績不明） */
  coverage: ReleaseReviewCoverage | null;
};

/**
 * 差分のファイルごとの確認実績（#4615）。**入力へ載せたこと（`inputFiles`）と確認したこと（`reviewed`）を分ける。**
 * 未確認は「省略（`unreviewed`＝入力に載せていない、または載せても根拠が無い）」と「取得不能（`unreadable`）」を区別する。
 */
export type ReleaseReviewCoverage = {
  /** 差分を確認用の入力へ載せたファイル数（確認実績ではない） */
  inputFiles: number;
  reviewed: number;
  unreadable: number;
  unreviewed: number;
  /** 未確認・取得不能のファイル（最大50件）と理由 */
  open: { file: string; kind: "unreviewed" | "unreadable"; reason: string }[];
  /** 確認を行ったバッチ数（分割しなかったときは1） */
  batches: number;
  /** 実行の予算で今回は行わなかったバッチ数 */
  pendingBatches: number;
};

export type NormalizedReleaseReview = {
  state: Extract<ReleaseVerificationState, "passed" | "needs_check" | "failed">;
  summary: string | null;
  detail: ReleaseReviewDetail;
  unverifiedScope: string | null;
};

const MAX_FINDINGS = 50;

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function prNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = value.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
  return [...new Set(numbers)].slice(0, 100);
}

type ParsedFinding = { finding: ReleaseReviewFinding; previousId: string | null; raw: Record<string, unknown> };

/** セキュリティ相当（認証・認可・データ境界・機密の露出）の確認項目。この項目の指摘は止める指摘に固定する */
export const RELEASE_REVIEW_SECURITY_CHECK_ID = "auth_boundary";

export type FindingBlockingInput = {
  /** AIの申告（`raw.blocking`）。真偽値以外は「申告なし」 */
  requested: unknown;
  severity: ReleaseReviewFinding["severity"];
  /** 確認項目の版を報告しない旧ランナーの結果か */
  legacy: boolean;
  /** セキュリティ相当の指摘か（`checkId`が`auth_boundary`） */
  security: boolean;
  file: string | null;
  impact: string | null;
  evidence: string | null;
  blockingReason: string | null;
  /** ランナーが実測した今回の対象ファイル。報告されていなければnull（差分内かの確認を行わない） */
  targetFiles: ReadonlySet<string> | null;
  /** 再レビューで見つかった新規の`initial_miss`が、修正差分に関係しないか */
  unrelatedInitialMiss: boolean;
};

export type FindingBlockingDecision = { blocking: boolean; demotedReason: string | null };

/** 根拠（`evidence`）が、集合のどれかのファイルパスを挙げているか */
function mentionsAny(text: string | null, files: ReadonlySet<string>): boolean {
  if (!text) return false;
  for (const file of files) if (text.includes(file)) return true;
  return false;
}

/**
 * 指摘を止める指摘にするか（#4765）。**止めるのは、今回の差分に起因し、具体的な実害と根拠がそろったものだけ。**
 *
 * - 旧ランナー（版なし）は従来どおり: 明示の`blocking: false`かつhigh以外だけが提案、フラグ無しは止める
 * - セキュリティ相当（`auth_boundary`）は申告や根拠の有無にかかわらず止める指摘に固定する
 * - それ以外は`blocking: true`の申告が必要で、次のどれかに当たれば提案へ降格し、理由を残す:
 *   申告が無い／再レビューの修正差分に関係しない初回の見落とし／`impact`・`evidence`・`blockingReason`の欠落／
 *   指摘のファイルが今回の対象外で、根拠が差分内のファイルを挙げていない
 */
export function decideFindingBlocking(input: FindingBlockingInput): FindingBlockingDecision {
  if (input.legacy) return { blocking: !(input.requested === false && input.severity !== "high"), demotedReason: null };
  if (input.security) return { blocking: true, demotedReason: null };
  if (input.requested === false) return { blocking: false, demotedReason: null };
  if (input.requested !== true) {
    return { blocking: false, demotedReason: "止める指摘かどうかの申告（blocking）が無いため、提案として扱いました" };
  }
  const reasons: string[] = [];
  if (input.unrelatedInitialMiss) {
    reasons.push("再レビューで見つかった初回の見落としで、修正差分に関係しません");
  }
  const missing = [
    input.impact ? null : "impact",
    input.evidence ? null : "evidence",
    input.blockingReason ? null : "blockingReason",
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) reasons.push(`止める根拠（${missing.join("・")}）がそろっていません`);
  const targets = input.targetFiles;
  if (targets && targets.size > 0 && !(input.file && targets.has(input.file)) && !mentionsAny(input.evidence, targets)) {
    reasons.push(
      input.file
        ? `指摘のファイル（${input.file}）が今回の差分に含まれず、根拠で差分内の変更が原因だと示されていません`
        : "指摘のファイルが無く、根拠で差分内の変更が原因だと示されていません",
    );
  }
  return reasons.length > 0 ? { blocking: false, demotedReason: reasons.join("／") } : { blocking: true, demotedReason: null };
}

function parseFinding(value: unknown): ParsedFinding | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const title = str(raw.title, 200);
  if (!title) return null;
  const severity = raw.severity === "high" || raw.severity === "low" ? raw.severity : "medium";
  const finding: ReleaseReviewFinding = {
    severity,
    title,
    detail: str(raw.detail, 2000) ?? "",
    file: str(raw.file, 300),
    line: typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null,
    impact: str(raw.impact, 1000),
    evidence: str(raw.evidence, 2000),
    recommendation: str(raw.recommendation, 1000),
    pullRequests: prNumbers(raw.pullRequests),
  };
  const checkId = str(raw.checkId, 64);
  if (checkId && RELEASE_REVIEW_CHECK_ITEM_IDS.includes(checkId)) finding.checkId = checkId;
  // 止めるかどうかは、確認項目の版・前回の記録・対象ファイルを見て`decideFindingBlocking`で決める（#4765）
  return { finding, previousId: str(raw.previousId, 32), raw };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const MAX_COVERAGE_TARGETS = 5000;
const MAX_OPEN_COVERAGE = 50;

/**
 * ランナーが報告したファイル別の実績（`targetFiles`・`fileReviews`・`inputFiles`）を、確認実績へ絞る。
 * **確認済みと数えるのは、対象に含まれ、`reviewed`で根拠があるものだけ。** 実績が報告されていない旧結果はnull
 */
export function normalizeCoverage(raw: Record<string, unknown>, totalFiles: number | null): ReleaseReviewCoverage | null {
  if (!Array.isArray(raw.targetFiles) || !Array.isArray(raw.fileReviews)) return null;
  const targets = [...new Set(raw.targetFiles.map((f) => str(f, 300)).filter((f): f is string => f !== null))].slice(
    0,
    MAX_COVERAGE_TARGETS,
  );
  if (targets.length === 0 && totalFiles !== 0) return null;
  const targetSet = new Set(targets);
  const reviewed = new Set<string>();
  const unreadable = new Map<string, string>();
  for (const entry of raw.fileReviews) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const file = str(rec.file, 300);
    if (!file || !targetSet.has(file)) continue;
    const evidence = str(rec.evidence, 500);
    if (rec.status === "unreadable") {
      unreadable.set(file, evidence ?? "取得できませんでした");
    } else if (rec.status === "reviewed" && evidence) {
      reviewed.add(file);
    }
  }
  // 取得できなかったファイルは、確認済みの記録があっても確認済みにしない（一部だけ読めた巨大ファイルなど）
  for (const file of unreadable.keys()) reviewed.delete(file);
  const open: ReleaseReviewCoverage["open"] = [];
  let unreviewed = 0;
  for (const file of targets) {
    if (reviewed.has(file)) continue;
    if (unreadable.has(file)) {
      if (open.length < MAX_OPEN_COVERAGE) open.push({ file, kind: "unreadable", reason: unreadable.get(file) ?? "" });
    } else {
      unreviewed += 1;
      if (open.length < MAX_OPEN_COVERAGE) open.push({ file, kind: "unreviewed", reason: "確認した根拠が報告されていません" });
    }
  }
  return {
    inputFiles: Math.min(nonNegativeInt(raw.inputFiles) ?? 0, targets.length),
    reviewed: reviewed.size,
    unreadable: unreadable.size,
    unreviewed,
    open,
    batches: nonNegativeInt(raw.batches) ?? 1,
    pendingBatches: nonNegativeInt(raw.pendingBatches) ?? 0,
  };
}

export function normalizeReleaseReview(
  body: unknown,
  context: ReleaseReviewNormalizeContext | null = null,
): NormalizedReleaseReview | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (raw.state !== "passed" && raw.state !== "needs_check" && raw.state !== "failed") return null;

  // 前回へ引き継げるかは、サーバーの文脈と、ランナーが実測した事実（追加PR・差分の有無）の両方で決める
  const addedPullRequests = prNumbers(raw.addedPullRequests);
  const runnerDenied = str(raw.fullReviewReason, 500);
  const previous = context?.previous ?? null;
  const reuse = context?.mode === "rereview" && previous !== null && runnerDenied === null;
  const mode: "initial" | "rereview" = reuse ? "rereview" : "initial";
  const fullReviewReason = reuse ? null : (runnerDenied ?? context?.fullReviewReason ?? (previous ? null : "前回の記録が無いため、対象全体を確認しました"));
  const previousFindings = context?.previousFindings ?? [];
  const previousById = new Map(previousFindings.map((f) => [f.id, f]));
  const decidedIds = new Set(context?.decidedFindingIds ?? []);

  // 確認項目の版を報告しない結果は旧ランナー。止める指摘の判定も従来どおりにする
  const reportedVersion = nonNegativeInt(raw.checklistVersion);
  const legacy = reportedVersion === null;
  const targetList = Array.isArray(raw.targetFiles)
    ? raw.targetFiles.map((f) => str(f, 300)).filter((f): f is string => f !== null)
    : [];
  const targetFiles = targetList.length > 0 ? new Set(targetList) : null;

  const parsed = (Array.isArray(raw.findings) ? raw.findings : [])
    .map(parseFinding)
    .filter((f): f is ParsedFinding => f !== null)
    .slice(0, MAX_FINDINGS);

  const fixTouched = new Set(
    (Array.isArray(raw.fixDiffFiles) ? raw.fixDiffFiles : []).filter((f): f is string => typeof f === "string"),
  );
  const prevRunFailed = previous?.runFailed === true;
  const toFinding = ({ finding, previousId, raw: r }: ParsedFinding): { finding: ReleaseReviewFinding; blocking: boolean } => {
    const derived = reviewFindingId(finding);
    const matched = previousId && previousById.has(previousId) ? previousId : previousById.has(derived) ? derived : null;
    // ユーザーが判断済みの指摘は、言い換えても`previousId`で同じIDへ戻す（判断が外れて未判断として蒸し返さない。#4657）
    const decided = !matched && previousId && decidedIds.has(previousId) ? previousId : decidedIds.has(derived) ? derived : null;
    const id = matched ?? decided ?? derived;
    const prior = matched ? previousById.get(matched) : undefined;
    const discovery = !prior && !decided && previous ? pick(r.discovery, RELEASE_REVIEW_DISCOVERIES, "unknown") : null;
    const reportedReason = str(r.blockingReason, 500);
    const { blocking, demotedReason } = decideFindingBlocking({
      requested: r.blocking,
      severity: finding.severity,
      legacy,
      security: finding.checkId === RELEASE_REVIEW_SECURITY_CHECK_ID,
      file: finding.file,
      impact: finding.impact,
      evidence: finding.evidence,
      blockingReason: reportedReason,
      targetFiles,
      // 修正差分のファイルを指していない・根拠で挙げていない初回の見落としは、修正と無関係
      unrelatedInitialMiss:
        discovery === "initial_miss" && !(finding.file && fixTouched.has(finding.file)) && !mentionsAny(finding.evidence, fixTouched),
    });
    const base: ReleaseReviewFinding = {
      ...finding,
      id,
      status: prior || decided ? "recurring" : "new",
      occurrences: prior ? prior.occurrences + 1 : 1,
      blockingReason: blocking ? reportedReason : null,
    };
    if (demotedReason) base.demotedReason = demotedReason;
    if (decidedIds.has(id)) base.premiseChanged = str(r.premiseChanged, 500);
    if (decided) return { finding: base, blocking };
    if (!prior) {
      base.discovery = discovery;
      return { finding: base, blocking };
    }
    const file = finding.file ?? prior.file;
    const reported = pick(r.stallCause, RELEASE_REVIEW_STALL_CAUSES, "unknown");
    base.stallCause = prevRunFailed
      ? "execution_failure"
      : file && fixTouched.size > 0 && !fixTouched.has(file)
        ? "unfixed"
        : reported !== "unknown"
          ? reported
          : fixTouched.size > 0
            ? "fix_ineffective"
            : "unknown";
    return { finding: base, blocking };
  };
  const decidedFindings = parsed.map(toFinding);
  const blockingFindings = decidedFindings.filter((d) => d.blocking).map((d) => d.finding);
  const suggestions = decidedFindings.filter((d) => !d.blocking).map((d) => d.finding);

  // 前回の止める指摘ごとの解消。**根拠の無い「解消」は未確認**、未解消と報告されたのに指摘へ載っていないものは
  // 指摘へ戻す（報告の取りこぼしで指摘が消えない）。提案として載っているもの（降格を含む）は戻さない（#4765）
  const resolutions: PreviousFindingResolution[] = [];
  const reportedResolutions = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(raw.previousFindings) ? raw.previousFindings : []) {
    if (typeof entry === "object" && entry !== null) {
      const id = str((entry as Record<string, unknown>).id, 32);
      if (id && !reportedResolutions.has(id)) reportedResolutions.set(id, entry as Record<string, unknown>);
    }
  }
  for (const prior of previousFindings) {
    const entry = reportedResolutions.get(prior.id);
    const evidence = str(entry?.evidence, 1500);
    const stillListed = blockingFindings.some((f) => f.id === prior.id);
    const listedAsSuggestion = suggestions.some((f) => f.id === prior.id);
    let status: PreviousFindingResolution["status"] = "not_checked";
    if (stillListed || listedAsSuggestion || entry?.status === "unresolved") status = "unresolved";
    else if (entry?.status === "resolved" && evidence) status = "resolved";
    if (status === "unresolved" && !stillListed && !listedAsSuggestion && blockingFindings.length < MAX_FINDINGS) {
      blockingFindings.push({
        severity: "medium",
        title: prior.title,
        detail: evidence ?? prior.detail,
        file: prior.file,
        line: prior.line,
        impact: null,
        evidence,
        recommendation: null,
        pullRequests: [],
        id: prior.id,
        status: "recurring",
        occurrences: prior.occurrences + 1,
        blockingReason: "前回の指摘が未解消と報告されました",
        stallCause: prevRunFailed ? "execution_failure" : "unknown",
      });
    }
    resolutions.push({ id: prior.id, title: prior.title, status, evidence });
  }

  const totalFiles = nonNegativeInt(raw.totalFiles);
  const coverage = normalizeCoverage(raw, totalFiles);
  // 確認済みの件数は、根拠つきのファイル別実績だけから数える。ランナーの申告する`reviewedFiles`（入力へ載せた数）は使わない
  const reviewedFiles = coverage ? coverage.reviewed : null;
  const affectedFiles = (Array.isArray(raw.affectedFiles) ? raw.affectedFiles : [])
    .map((f) => str(f, 300))
    .filter((f): f is string => f !== null)
    .slice(0, 200);

  // 確認項目。版が違う・項目別の記録が無い（旧ランナー）結果は、全項目を未確認として扱う
  const versionOk = reportedVersion === RELEASE_REVIEW_CHECKLIST_VERSION;
  const checks = normalizeCheckResults({
    raw: versionOk ? raw.checks : [],
    carryOverAllowed: reuse,
    previous: previous ? { headSha: previous.headSha, statuses: previous.statuses } : null,
  }).map((c) =>
    versionOk
      ? c
      : { ...c, evidence: legacy ? "項目別の確認記録がありません（旧ランナーの結果）" : "確認項目の版が一致しません" },
  );

  const unverified: string[] = [];
  const reported = str(raw.unverifiedScope, 2000);
  if (reported) unverified.push(reported);
  if (coverage && totalFiles !== null && coverage.reviewed < totalFiles) {
    const parts = [
      coverage.unreviewed > 0 ? `未確認${coverage.unreviewed}` : null,
      coverage.unreadable > 0 ? `取得不能${coverage.unreadable}` : null,
    ].filter((v): v is string => v !== null);
    const pending = coverage.pendingBatches > 0 ? `。残り${coverage.pendingBatches}バッチは再実行で続きから確認します` : "";
    unverified.push(`差分${totalFiles}ファイルのうち${coverage.reviewed}ファイルを確認済み（${parts.join("・")}）${pending}`);
  } else if (!coverage && totalFiles !== null) {
    unverified.push("ファイル別の確認実績がありません（旧ランナーの結果。確認済みの件数は不明です）");
  }
  if (legacy) unverified.push("項目別の確認記録がありません（旧ランナーの結果。サブPCのpollerを更新して再実行してください）");
  else if (!versionOk) unverified.push(`確認項目の版が一致しません（結果v${reportedVersion}・現在v${RELEASE_REVIEW_CHECKLIST_VERSION}）`);
  else {
    const open = describeUnconfirmedChecks(checks);
    if (open) unverified.push(open);
  }
  const unchecked = resolutions.filter((r) => r.status === "not_checked");
  if (unchecked.length > 0) unverified.push(`前回の指摘${unchecked.map((r) => r.id).join("・")}の解消を確認できていません`);
  const unverifiedScope = unverified.length > 0 ? [...new Set(unverified)].join(" / ") : null;

  // 未確認範囲だけの場合は`passed`のまま持つ。`viewReleaseVerifications`が未確認範囲つきの
  // `passed`を理由付きの`needs_check`へ読み替えるので、ゲートの理由に範囲が出る。
  // **止める指摘だけが`needs_check`にする。改善提案だけでは止めない**
  const state = raw.state === "failed" ? "failed" : blockingFindings.length > 0 ? "needs_check" : "passed";
  const review: ReleaseReviewMeta = {
    checklistVersion: reportedVersion,
    legacy,
    mode,
    fullReviewReason,
    recheckScope: mode === "rereview" ? str(raw.recheckScope, 1500) : null,
    previous: previous ? { prNumber: previous.prNumber, baseSha: previous.baseSha, headSha: previous.headSha } : null,
    fixDiffFileCount: nonNegativeInt(raw.fixDiffFileCount),
    addedPullRequests,
    checks,
    previousFindings: resolutions,
  };
  return {
    state,
    summary: str(raw.summary, 20000),
    detail: {
      findings: blockingFindings,
      suggestions,
      review,
      affectedPullRequests: [
        ...new Set([...prNumbers(raw.affectedPullRequests), ...blockingFindings.flatMap((f) => f.pullRequests)]),
      ],
      affectedFiles,
      reviewedFiles,
      totalFiles,
      coverage,
    },
    unverifiedScope,
  };
}
