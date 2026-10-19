import { describeSection } from "@/components/dashboard/release-review-sections";
import type { ReleaseMacSection } from "@/lib/release-mac-verification";
import type { ReleaseVerificationSection, ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/**
 * 6項目のうち、リリース候補の共通結果（全体レビュー・統合検証・iOS検証。#4366）の対象解決と表示内容。
 *
 * **対象は固定リリース候補（base=main・head=`release-main/v*`のopenなPR）。** 通常PRが候補に含まれるかは
 * 候補PRのコミット範囲に載っているPR番号で決め、無関係な最新の候補の結果を転用しない。
 * 含まれる候補が無ければ「リリース未作成」の理由付きで未実施にする。複数あれば選択できるようにする。
 */
export type ReleaseCandidate = {
  number: number;
  title: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  /** 候補のコミット範囲に含まれるPR番号 */
  pullRequestNumbers: number[];
  verification: ReleaseVerificationSummary;
};

/** `GET /api/repositories/release/candidates`の取得状態 */
export type ReleaseCandidatesSource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; candidates: ReleaseCandidate[] };

export type ReleaseCheckTone = "ok" | "bad" | "warn" | "run" | "muted";

/** 1項目ぶんの共通の表示内容 */
export type ReleaseCheckCell = {
  mark: string;
  state: string;
  tone: ReleaseCheckTone;
  reason: string | null;
};

export type ReleaseCheckCells = {
  all: ReleaseCheckCell;
  integration: ReleaseCheckCell;
  mac: ReleaseCheckCell;
  /** 判定の対象にしている候補。無ければnull（読み込み中・未作成・取得不可） */
  candidate: ReleaseCandidate | null;
  /** 対象にできる候補（2件以上なら選択肢として出す。新しい順） */
  choices: ReleaseCandidate[];
};

/**
 * `prNumber`を含む候補を新しい順に返す。候補PR自身（`prNumber`が候補の番号）も含める。
 * 候補が`prNumber`を含むかは、対象のSHAと同じ取得（コミット範囲）で決める。
 */
export function candidatesForPullRequest(candidates: readonly ReleaseCandidate[], prNumber: number): ReleaseCandidate[] {
  return candidates
    .filter((candidate) => candidate.number === prNumber || candidate.pullRequestNumbers.includes(prNumber))
    .sort((a, b) => b.number - a.number);
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** 対象の候補を、画面に出す1行へ */
export function describeCandidateTarget(candidate: ReleaseCandidate): string {
  return `候補PR #${candidate.number}（${candidate.headRef}・head ${shortSha(candidate.headSha)}）`;
}

function fromSection(section: ReleaseVerificationSection, nowMs: number): ReleaseCheckCell {
  const head = describeSection(section, nowMs);
  const reason = [head.detail, head.reason].filter((v): v is string => Boolean(v)).join("。") || null;
  return { mark: head.mark, state: head.label, tone: head.tone, reason };
}

const MAC_CELL: Record<ReleaseMacSection["state"], Pick<ReleaseCheckCell, "mark" | "state" | "tone">> = {
  passed: { mark: "●", state: "成功", tone: "ok" },
  failed: { mark: "■", state: "失敗", tone: "bad" },
  running: { mark: "◷", state: "実行中", tone: "run" },
  not_applicable: { mark: "⊘", state: "対象外", tone: "muted" },
  needs_setup: { mark: "▲", state: "設定不足", tone: "warn" },
  not_recorded: { mark: "–", state: "未実施", tone: "muted" },
  invalidated: { mark: "⟳", state: "古い結果", tone: "warn" },
};

function fromMac(mac: ReleaseMacSection | undefined): ReleaseCheckCell {
  // 古いサーバーの応答（`mac`が無い）は記録なし（未実施）として扱い、成功には倒さない
  const resolved = mac ?? { state: "not_recorded" as const, reason: "iOS検証の記録がありません" };
  return { ...MAC_CELL[resolved.state], reason: resolved.reason };
}

const LOADING: ReleaseCheckCell = { mark: "◷", state: "取得中", tone: "muted", reason: null };

/**
 * 候補の共通結果3項目を決める。
 * @param selectedNumber 複数候補のうち選んだ候補PR番号。無い・該当しなければ最新の候補
 */
export function buildReleaseCheckCells(input: {
  source: ReleaseCandidatesSource;
  pullRequestNumber: number;
  selectedNumber?: number | null;
  nowMs: number;
}): ReleaseCheckCells {
  const { source } = input;
  if (source.status === "loading") {
    return { all: LOADING, integration: LOADING, mac: LOADING, candidate: null, choices: [] };
  }
  if (source.status === "error") {
    const cell: ReleaseCheckCell = {
      mark: "？",
      state: "取得不可",
      tone: "warn",
      reason: `${source.message}。成功とは扱いません`,
    };
    return { all: cell, integration: cell, mac: cell, candidate: null, choices: [] };
  }
  const choices = candidatesForPullRequest(source.candidates, input.pullRequestNumber);
  if (choices.length === 0) {
    const cell: ReleaseCheckCell = {
      mark: "–",
      state: "リリース未作成",
      tone: "muted",
      reason: "この変更を含むリリース候補がまだありません。候補ができると、その結果をここに出します",
    };
    return { all: cell, integration: cell, mac: cell, candidate: null, choices };
  }
  const candidate = choices.find((c) => c.number === input.selectedNumber) ?? choices[0];
  const { verification } = candidate;
  return {
    all: fromSection(verification.aiReview, input.nowMs),
    integration: fromSection(verification.integration, input.nowMs),
    mac: fromMac(verification.mac),
    candidate,
    choices,
  };
}
