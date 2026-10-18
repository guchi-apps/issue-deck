/**
 * リリースPR（base=`main`・head=`release-main/v*`）を通常の本番マージへ進めてよいかの判定（#4212）。
 *
 * **画面と`POST /api/issues/pull-request-merge`が同じ関数を使う。** 画面の表示だけで制御すると、
 * 古い画面や別経路から古い結果でマージできてしまうため、サーバー側でも鮮度と結果を再判定する。
 *
 * 個別PRのレビュー（#4092の「記録なし」判定）はここでは扱わない。あちらは表示のみで、
 * リリース単位の統合検証・全体レビューとは責務が別。
 */

import type { ReleasePrerequisiteBlocker } from "@/lib/execution-plan/release-link";
import { isReleaseCandidateHeadRef } from "@/lib/release-branch";

/** 固定リリースに対する検証の種別 */
export const RELEASE_VERIFICATION_KINDS = ["integration", "ai_review"] as const;
export type ReleaseVerificationKind = (typeof RELEASE_VERIFICATION_KINDS)[number];

/** 検証1件の状態。段を増やすときは画面の色と判定を1対1で揃える */
export const RELEASE_VERIFICATION_STATES = [
  "not_run",
  "waiting",
  "running",
  "passed",
  "failed",
  "needs_check",
  "not_applicable",
] as const;
export type ReleaseVerificationState = (typeof RELEASE_VERIFICATION_STATES)[number];

export function parseReleaseVerificationState(value: unknown): ReleaseVerificationState | null {
  return typeof value === "string" && (RELEASE_VERIFICATION_STATES as readonly string[]).includes(value)
    ? (value as ReleaseVerificationState)
    : null;
}

export function parseReleaseVerificationKind(value: unknown): ReleaseVerificationKind | null {
  return typeof value === "string" && (RELEASE_VERIFICATION_KINDS as readonly string[]).includes(value)
    ? (value as ReleaseVerificationKind)
    : null;
}

/** 記録された検証結果1件（`ReleaseVerification`の行から必要な列だけ） */
export type ReleaseVerificationRecord = {
  kind: ReleaseVerificationKind;
  state: ReleaseVerificationState;
  baseSha: string;
  headSha: string;
  /** 一部しか確認できなかった範囲。空でなければ全範囲確認済みのLGTMと区別する */
  unverifiedScope?: string | null;
};

/** 画面に出す1区分ぶんの状態。`invalidated`は記録のSHAが現在の対象と食い違うとき */
export type ReleaseVerificationView =
  | { kind: ReleaseVerificationKind; state: ReleaseVerificationState; reason?: string }
  | { kind: ReleaseVerificationKind; state: "invalidated"; reason: string };

export type ReleaseMergeGateInput = {
  /** マージ直前にGitHubから取り直した現在のSHA */
  current: { baseSha: string; headSha: string };
  records: readonly ReleaseVerificationRecord[];
  /**
   * 検証の結果による強制を有効にしているか。無効なら従来どおり結果では判定しない（未配布を導入済みと扱わない）。
   * **実行中・待機中の完了待ち（`evaluateReleaseVerificationWait`）はこのフラグの対象外**で、常に有効
   */
  enforced: boolean;
  /**
   * 公開前に終わっていないpre-releaseの前提（#4523。`evaluateReleasePrerequisites`の結果）。
   * **`enforced`とは独立に効く**（検証結果の強制を導入していないリポジトリでも、環境設定の未完了で公開させない）
   */
  prerequisites?: readonly ReleasePrerequisiteBlocker[];
};

export type ReleaseMergeGateBlocker = {
  kind: ReleaseVerificationKind;
  state: ReleaseVerificationState | "invalidated";
  reason: string;
};

export type ReleaseMergeGate = ReleaseMergeGateBase & { prerequisites: ReleasePrerequisiteBlocker[] };

type ReleaseMergeGateBase =
  | { status: "not_enforced"; views: ReleaseVerificationView[]; blockers: [] }
  /** 通常のマージへ進める */
  | { status: "ready"; views: ReleaseVerificationView[]; blockers: [] }
  /** 理由を示して既存の明示確認フローへ渡す（失敗・未実施はここに入れない） */
  | { status: "needs_confirmation"; views: ReleaseVerificationView[]; blockers: ReleaseMergeGateBlocker[] }
  /** 通常のマージはできない */
  | { status: "blocked"; views: ReleaseVerificationView[]; blockers: ReleaseMergeGateBlocker[] };

const KIND_LABEL: Record<ReleaseVerificationKind, string> = {
  integration: "統合検証",
  ai_review: "リリース全体レビュー",
};

/** 現在の対象に紐づく最新の記録だけを、種別ごとに画面用の状態へ畳む */
export function viewReleaseVerifications(
  current: { baseSha: string; headSha: string },
  records: readonly ReleaseVerificationRecord[],
): ReleaseVerificationView[] {
  return RELEASE_VERIFICATION_KINDS.map((kind): ReleaseVerificationView => {
    const ofKind = records.filter((r) => r.kind === kind);
    const matching = ofKind.find((r) => r.baseSha === current.baseSha && r.headSha === current.headSha);
    if (matching) {
      const scope = matching.unverifiedScope?.trim();
      if (matching.state === "passed" && scope) {
        return { kind, state: "needs_check", reason: `未確認範囲があります: ${scope}` };
      }
      return { kind, state: matching.state };
    }
    if (ofKind.length > 0) {
      return {
        kind,
        state: "invalidated",
        reason: "対象（mainの先端またはリリースブランチの先端）が変わったため、古い結果は使えません",
      };
    }
    return { kind, state: "not_run" };
  });
}

export function evaluateReleaseMergeGate(input: ReleaseMergeGateInput): ReleaseMergeGate {
  const prerequisites = [...(input.prerequisites ?? [])];
  const gate = evaluateVerificationGate(input);
  if (prerequisites.length === 0) return { ...gate, prerequisites };
  // 前提が未完了なら、検証が通っていても通常のマージへ進めない。検証側の指摘は残して返す
  return { status: "blocked", views: gate.views, blockers: gate.blockers, prerequisites };
}

function evaluateVerificationGate(input: ReleaseMergeGateInput): ReleaseMergeGateBase {
  const views = viewReleaseVerifications(input.current, input.records);
  if (!input.enforced) return { status: "not_enforced", views, blockers: [] };

  const hard: ReleaseMergeGateBlocker[] = [];
  const soft: ReleaseMergeGateBlocker[] = [];
  for (const view of views) {
    const label = KIND_LABEL[view.kind];
    switch (view.state) {
      case "passed":
      case "not_applicable":
        break;
      case "needs_check":
        soft.push({
          kind: view.kind,
          state: view.state,
          reason: `${label}: ${view.reason ?? "要確認の結果があります"}`,
        });
        break;
      case "failed":
        hard.push({ kind: view.kind, state: view.state, reason: `${label}が失敗しています` });
        break;
      case "invalidated":
        hard.push({ kind: view.kind, state: view.state, reason: `${label}: ${view.reason}` });
        break;
      case "running":
      case "waiting":
        hard.push({ kind: view.kind, state: view.state, reason: `${label}が完了していません` });
        break;
      case "not_run":
        hard.push({ kind: view.kind, state: view.state, reason: `${label}が未実施です` });
        break;
    }
  }
  if (hard.length > 0) return { status: "blocked", views, blockers: [...hard, ...soft] };
  if (soft.length > 0) return { status: "needs_confirmation", views, blockers: soft };
  return { status: "ready", views, blockers: [] };
}

export type ReleaseVerificationPending = { kind: ReleaseVerificationKind; state: "waiting" | "running"; reason: string };

/**
 * 統合検証・全体レビューの判定が出るまでのマージ待ち（#4354）。
 * **結果（失敗・要確認・古い結果）では止めない。** 実行中・待機中の検証だけを待ちとして返す。
 * 記録が無い（依頼されていない）ものは待たない。`enforced`とは独立に効く
 */
export function evaluateReleaseVerificationWait(input: {
  current: { baseSha: string; headSha: string };
  records: readonly ReleaseVerificationRecord[];
}): ReleaseVerificationPending[] {
  const pending: ReleaseVerificationPending[] = [];
  for (const view of viewReleaseVerifications(input.current, input.records)) {
    if (view.state === "waiting" || view.state === "running") {
      pending.push({ kind: view.kind, state: view.state, reason: `${KIND_LABEL[view.kind]}の判定が出ていません` });
    }
  }
  return pending;
}

/**
 * マージ対象がリリース候補のPR（base=main・head=`release-main/v*`または新方式の`release-rc/<番号>`）か。
 * ゲートはここにだけ掛ける（#4495で新方式の候補も対象にした）
 */
export function isReleasePullRequest(pr: { baseRef: string; headRef: string }): boolean {
  return pr.baseRef === "main" && isReleaseCandidateHeadRef(pr.headRef);
}
