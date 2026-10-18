import { decideDeployRecoveryRelease, DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS, type DeployRunObservation } from "@/lib/deploy-recovery-series";
import type { ProductionTargetKind, ProductionVerificationMethod, ProductionWaitReason } from "@/lib/release-production-verification";

/**
 * 公開済みの候補の稼働確認が「止まっている」か（#4712）。**純関数だけ**を置く。
 *
 * 証拠の判定（どの方式で完了にできるか）は#4713の`decideProductionEvidence`が持つ。ここが持つのは、その判定が
 * まだ完了でないときに、**待てば進む（スピナーを出してよい）のか、待っても進まない（原因と操作を出す）のか**の区別と、
 * 証拠未設定の候補を照合付きの次の候補で確かめる経路（循環の回避）だけ。
 *
 * - 判断は毎回の観測だけで決める。止まった理由は候補へ記録して画面へ出すが確定ではなく、次の巡回で証拠が揃えば
 *   そのまま完了する（記録を消して進行中へ戻すこともある）
 * - HTTP 200・マージ済み・Releaseの存在・workflowの文字列だけで完了にしない（#4007・#4673）
 */

export const PRODUCTION_STOP_REASONS = [
  "contract_missing",
  "version_mismatch",
  "evidence_unreadable",
  "deploy_not_started",
  "deploy_failed",
  "deploy_cancelled",
  "version_unverified",
  "source_unpublished",
] as const;
export type ProductionStopReason = (typeof PRODUCTION_STOP_REASONS)[number];

export function parseProductionStopReason(value: unknown): ProductionStopReason | null {
  return typeof value === "string" && (PRODUCTION_STOP_REASONS as readonly string[]).includes(value) ? (value as ProductionStopReason) : null;
}

const RECHECK = "直したら「稼働確認をやり直す」を押してください";

/** 止まった理由ごとの短い名前・原因・次の操作。PCの候補画面・スマホの「次の操作」・開始判定が同じ文面を出す */
export const PRODUCTION_STOP_TEXT: Record<ProductionStopReason, { label: string; cause: string; action: string }> = {
  contract_missing: {
    label: "証拠未設定",
    cause: "このコミットの配布workflowは稼働版を照合しておらず（APP_COMMIT_SHAと/api/app-versionの突き合わせが無い）、稼働中の版を確かめる証拠がありません",
    action:
      "稼働版を返す公開URLを登録して照合するか、確かめた内容を書いて確定してください。照合をdevelopへ入れた場合は次の候補を開始でき、次の候補の稼働確認でこの候補を含む版の稼働を確かめた時点でこの候補も完了します",
  },
  version_mismatch: {
    label: "旧版が応答",
    cause: "公開URLが対象コミットと別の版を返しています（再起動に失敗して旧版が動いている可能性があります）",
    action: `本番のプロセスと配備物を確かめてください。${RECHECK}`,
  },
  evidence_unreadable: {
    label: "取得不能",
    cause: "稼働確認の材料（照合を含むdeployジョブ・公開URLの版情報）を取得できませんでした",
    action: "「稼働確認をやり直す」で取り直してください。取得できるまで完了にしません",
  },
  deploy_not_started: {
    label: "デプロイ未起動",
    cause: "mainへのマージ後、対象コミットの本番デプロイが起動していません",
    action: `デプロイを起動してください。${RECHECK}`,
  },
  deploy_failed: {
    label: "デプロイ失敗",
    cause: "本番デプロイが失敗しました（照合付きのrepoでは、稼働版の不一致・旧版の応答もヘルスチェックの失敗としてここに出ます）",
    action: `デプロイを再実行するか本番復旧で直してください。${RECHECK}`,
  },
  deploy_cancelled: {
    label: "デプロイ取消",
    cause: "対象コミットの本番デプロイが取り消されました",
    action: `デプロイを再実行してください。${RECHECK}`,
  },
  version_unverified: {
    label: "照合未完了",
    cause: "デプロイは成功しましたが、稼働版を照合する`deploy`ジョブの成功を確かめられません",
    action: `デプロイの実行内容を確かめてください。${RECHECK}`,
  },
  source_unpublished: {
    label: "公開未確認",
    cause: "対象コミットを指すタグの公開済みReleaseを確認できません",
    action: `公開workflowの結果を確かめてください。${RECHECK}`,
  },
};

/** 完了の根拠（#4713の方式）ごとに、完了した候補へ出す説明 */
export const PRODUCTION_COMPLETION_TEXT: Partial<Record<ProductionVerificationMethod, string>> = {
  deploy_version_check: "本番の稼働版が対象コミットと一致することを、デプロイの照合で確かめました",
  public_version_url: "公開URLが返す版情報が対象コミットと一致することを確かめました",
  manual_attestation: "確かめた内容の記録（人の確認）で完了にしました",
  source_publish: "対象コミットのソースを公開しました（タグとReleaseを確認）。実機への配備はこの確認の対象外で、未確認です",
  successor: "この候補を含む後続の版が本番で稼働していることを、後続のデプロイの照合で確かめました",
};

export type ProductionStopInput = {
  now: Date;
  /** 待ち時間の起点（マージ時刻、または「稼働確認をやり直す」を押した時刻） */
  startedAt: Date;
  mergeSha: string;
  kind: ProductionTargetKind;
  /** #4713の判定が完了でないときの理由 */
  waitingReason: ProductionWaitReason;
  /** 対象コミットのdeploy run（deployするrepoのみ） */
  runs: DeployRunObservation[];
};

export type ProductionStopDecision =
  /** 待てば進む。スピナーを出してよいのはここだけ */
  | { stop: null; stage: "deploying" | "verifying" }
  | { stop: ProductionStopReason; detail: string | null; stage: "deploying" | "verifying" };

/**
 * 証拠がまだ揃わないとき、止まっているかを決める。
 * - deployするrepo: 対象コミットの**最新のrun**だけを見る（再実行・重複実行は最新に置き換わる）。進行中・1回目の失敗の
 *   再実行待ちは待つ。成功した後に証拠が無い・旧版が応答・取得できないは、待っても進まないので止める
 * - ソース公開: 公開が終わるまで待ち、期限を過ぎたら止める
 * - 方式を判定できない（配布workflowが無い）: 証拠未設定として止める
 */
export function decideProductionStop(input: ProductionStopInput): ProductionStopDecision {
  const timedOut = input.now.getTime() - input.startedAt.getTime() >= DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS;
  if (input.kind === "unknown") return { stop: "contract_missing", detail: "配布のworkflow（deploy.yml・release-artifacts.yml）がありません", stage: "verifying" };
  if (input.kind === "source_publish_only") {
    return timedOut ? { stop: "source_unpublished", detail: null, stage: "verifying" } : { stop: null, stage: "verifying" };
  }

  const latest = input.runs
    .filter((run) => run.headSha === input.mergeSha)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  if (latest?.status === "completed" && latest.conclusion === "cancelled") return { stop: "deploy_cancelled", detail: latest.htmlUrl, stage: "deploying" };

  const release = decideDeployRecoveryRelease(
    { releaseSha: input.mergeSha, releaseStartedAt: input.startedAt, releaseAttempts: 0, lastFailureKey: null },
    { now: input.now, runs: input.runs, versionVerified: false },
  );
  switch (release.action) {
    case "wait":
    case "recovered":
      return { stop: null, stage: "deploying" };
    case "requeue":
      return { stop: "deploy_failed", detail: release.run.htmlUrl, stage: "deploying" };
    case "track":
      if (release.status === "releasing") return { stop: null, stage: "deploying" };
      return afterDeploySucceeded(input, release.run.htmlUrl);
    case "stop":
      if (release.reason === "version_unverified") return afterDeploySucceeded(input, release.detail ?? null);
      if (release.reason === "deploy_not_started") return { stop: "deploy_not_started", detail: null, stage: "deploying" };
      if (release.reason === "deploy_cancelled") return { stop: "deploy_cancelled", detail: release.detail ?? null, stage: "deploying" };
      return { stop: "deploy_failed", detail: release.detail ?? null, stage: "deploying" };
  }
}

/** 対象コミットのdeployが成功した後。#4713の待ちの理由を、止まっている理由へ読み替える */
function afterDeploySucceeded(input: ProductionStopInput, runUrl: string | null): ProductionStopDecision {
  switch (input.waitingReason) {
    case "version_mismatch":
      return { stop: "version_mismatch", detail: runUrl, stage: "verifying" };
    case "probe_unreadable":
      return { stop: "evidence_unreadable", detail: runUrl, stage: "verifying" };
    case "no_evidence":
      // 照合付きのrepoで証拠が無い＝照合を含むdeployジョブの成功を確かめられない
      return input.kind === "deploy_version_check"
        ? { stop: "version_unverified", detail: runUrl, stage: "verifying" }
        : { stop: "contract_missing", detail: runUrl, stage: "verifying" };
    default:
      return { stop: "evidence_unreadable", detail: runUrl, stage: "verifying" };
  }
}

/**
 * 後続の版による確認。後続のコミットが**照合付きのWeb配備で稼働を確かめられ**、かつこの候補のマージコミットを
 * 祖先に持つときだけ認める。ソース公開・照合の無い後続では認めない
 */
export function decideSuccessorProof(input: {
  coveredSha: string;
  successor: { sha: string; runUrl: string; kind: ProductionTargetKind | null; versionCheckPassed: boolean; includesCovered: boolean } | null;
}): { ok: true; evidence: { coveredSha: string; successorSha: string; deployRunUrl: string } } | { ok: false } {
  const s = input.successor;
  if (!s || s.sha === input.coveredSha || s.kind !== "deploy_version_check" || !s.versionCheckPassed || !s.includesCovered) return { ok: false };
  return { ok: true, evidence: { coveredSha: input.coveredSha, successorSha: s.sha, deployRunUrl: s.runUrl } };
}

/**
 * 稼働確認が止まった候補があるとき、次の候補を始めてよいか。**証拠未設定の候補だけ**が対象で、次の候補が
 * 照合を持つ（developの`deploy.yml`が照合を含む）ときに限る。照合を入れるには次の候補を公開するしかなく、
 * 旧い候補がそれを阻むと循環するため。それ以外の停止（失敗・取得不能・旧版の応答など）は、その候補を直して確かめ直す
 */
export function decideSuccessorStart(input: {
  stopReason: ProductionStopReason | null;
  developKind: ProductionTargetKind | null;
  /** 後続の確認を待つ候補が既にあるか（同じリポジトリで1本まで） */
  slotTaken: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.stopReason !== "contract_missing") return { allowed: false, reason: "この候補の稼働確認を直して確かめ直すまで、新しい候補は作れません" };
  if (input.slotTaken) return { allowed: false, reason: "後続の稼働確認を待っている別の候補があります。その候補の完了を先に確かめてください" };
  if (input.developKind === null) return { allowed: false, reason: "developの配布workflowを読めず、次の候補が稼働版の照合を持つか確かめられません" };
  if (input.developKind !== "deploy_version_check") {
    return { allowed: false, reason: "developのdeploy.ymlにまだ稼働版の照合（APP_COMMIT_SHAと/api/app-version）がありません。照合を入れると次の候補を開始できます" };
  }
  return { allowed: true };
}

/** 開始前に出す、稼働確認の方式についての注意。照合付きのWeb配備ならnull */
export function productionKindNotice(kind: ProductionTargetKind | null | undefined): string | null {
  if (kind === undefined || kind === "deploy_version_check") return null;
  if (kind === null) return "developの配布workflowを読めず、公開後の稼働確認ができるか確かめられません";
  if (kind === "source_publish_only") return "ソースの公開までを確かめます。実機への配備は稼働確認の対象外で、別に確かめる必要があります";
  if (kind === "unknown") return "配布のworkflowが無いため、公開後の稼働確認は確かめた内容の記録（人の確認）でしか完了できません";
  return "developのdeploy.ymlは稼働版を照合しません（APP_COMMIT_SHAと/api/app-versionの突き合わせが無い）。公開後は公開URLの照合か人の確認が要り、無ければ稼働確認で止まります";
}
