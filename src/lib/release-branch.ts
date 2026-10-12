/**
 * リリース候補（→`main`）のheadブランチの判定（#4495）。
 *
 * 候補は2つの方式が共存する。
 * - 旧方式: 正式版を上げてから作る`release-main/vX.Y.Z`（#2117）。作り直しはバンプの取り消し・再生成を伴う
 * - 新方式: 正式版を上げる前に固定する`release-rc/<候補番号>`。候補の正はDBの`ReleaseCandidate`で、
 *   ブランチ名には版を入れない（版は公開準備で確定する。#4496）
 *
 * 検証・修正系列・完了系列・本番PR詳細の対象は`isReleaseCandidateHeadRef`で判定し、`release-main/`を
 * 直書きしない。凍結ブランチを閉じて消す旧方式専用の作り直し（#3014）だけは`isLegacyReleaseCandidateHeadRef`を使う。
 *
 * 依存の無い小さなモジュールにしてあるのは、画面・巡回・純関数のどこからでも同じ判定を読めるようにするため。
 */

/** 新方式の候補ブランチの接頭辞。`release/v`（バンプPR）・`release-main/v`（旧方式）と重ならない */
export const RELEASE_RC_BRANCH_PREFIX = "release-rc/";

/** 旧方式（`release-main/vX.Y.Z`）のリリース候補か */
export function isLegacyReleaseCandidateHeadRef(headRef: string): boolean {
  return /^release-main\/v\d/.test(headRef);
}

/** 新方式（`release-rc/<番号>`）のリリース候補か */
export function isRcReleaseCandidateHeadRef(headRef: string): boolean {
  return /^release-rc\/\d+$/.test(headRef);
}

/** 固定したリリース候補のheadか（旧方式・新方式の両方） */
export function isReleaseCandidateHeadRef(headRef: string): boolean {
  return isLegacyReleaseCandidateHeadRef(headRef) || isRcReleaseCandidateHeadRef(headRef);
}

/** 新方式の候補ブランチ名 */
export function rcBranchName(sequence: number): string {
  return `${RELEASE_RC_BRANCH_PREFIX}${sequence}`;
}

/** 新方式の候補ブランチから候補番号を読む。新方式でなければnull */
export function rcSequenceOf(headRef: string): number | null {
  return isRcReleaseCandidateHeadRef(headRef) ? Number(headRef.slice(RELEASE_RC_BRANCH_PREFIX.length)) : null;
}

/** 旧方式の候補ブランチから版を読む（`release-main/v8.54.0`→`8.54.0`）。旧方式でなければnull */
export function legacyReleaseVersionOf(headRef: string): string | null {
  return isLegacyReleaseCandidateHeadRef(headRef) ? headRef.slice("release-main/v".length) : null;
}
