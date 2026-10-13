import { createHash } from "node:crypto";

import type { ReleaseVerificationState } from "@/lib/release-merge-gate";
import {
  RELEASE_REVIEW_CHECKLIST_VERSION,
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
  reviewedFiles: number | null;
  totalFiles: number | null;
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

type ParsedFinding = { finding: ReleaseReviewFinding; blocking: boolean; previousId: string | null; raw: Record<string, unknown> };

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
  // 止めない提案にできるのは明示（`blocking: false`）されたものだけ。**severityがhighのものは提案にしない**
  // （実害のある問題を「軽微」として回避させない）。旧形式（フラグ無し）は従来どおり止める指摘
  const blocking = !(raw.blocking === false && severity !== "high");
  return { finding, blocking, previousId: str(raw.previousId, 32), raw };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
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

  const parsed = (Array.isArray(raw.findings) ? raw.findings : [])
    .map(parseFinding)
    .filter((f): f is ParsedFinding => f !== null)
    .slice(0, MAX_FINDINGS);

  const fixTouched = new Set(
    (Array.isArray(raw.fixDiffFiles) ? raw.fixDiffFiles : []).filter((f): f is string => typeof f === "string"),
  );
  const prevRunFailed = previous?.runFailed === true;
  const toFinding = ({ finding, blocking, previousId, raw: r }: ParsedFinding): ReleaseReviewFinding => {
    const derived = reviewFindingId(finding);
    const matched = previousId && previousById.has(previousId) ? previousId : previousById.has(derived) ? derived : null;
    const id = matched ?? derived;
    const prior = matched ? previousById.get(matched) : undefined;
    const base: ReleaseReviewFinding = {
      ...finding,
      id,
      status: prior ? "recurring" : "new",
      occurrences: prior ? prior.occurrences + 1 : 1,
      blockingReason: blocking ? str(r.blockingReason, 500) : null,
    };
    if (!prior) {
      base.discovery = previous ? pick(r.discovery, RELEASE_REVIEW_DISCOVERIES, "unknown") : null;
      return base;
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
    return base;
  };
  const blockingFindings = parsed.filter((p) => p.blocking).map(toFinding);
  const suggestions = parsed.filter((p) => !p.blocking).map(toFinding);

  // 前回の止める指摘ごとの解消。**根拠の無い「解消」は未確認**、未解消と報告されたのに指摘へ載っていないものは
  // 指摘へ戻す（報告の取りこぼしで指摘が消えない）
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
    let status: PreviousFindingResolution["status"] = "not_checked";
    if (stillListed || entry?.status === "unresolved") status = "unresolved";
    else if (entry?.status === "resolved" && evidence) status = "resolved";
    if (status === "unresolved" && !stillListed && blockingFindings.length < MAX_FINDINGS) {
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

  const reviewedFiles = nonNegativeInt(raw.reviewedFiles);
  const totalFiles = nonNegativeInt(raw.totalFiles);
  const affectedFiles = (Array.isArray(raw.affectedFiles) ? raw.affectedFiles : [])
    .map((f) => str(f, 300))
    .filter((f): f is string => f !== null)
    .slice(0, 200);

  // 確認項目。版が違う・項目別の記録が無い（旧ランナー）結果は、全項目を未確認として扱う
  const reportedVersion = nonNegativeInt(raw.checklistVersion);
  const legacy = reportedVersion === null;
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
  if (reviewedFiles !== null && totalFiles !== null && reviewedFiles < totalFiles) {
    unverified.push(`差分${totalFiles}ファイルのうち${reviewedFiles}ファイルしか確認できていません`);
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
    },
    unverifiedScope,
  };
}
