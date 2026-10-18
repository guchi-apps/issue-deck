/**
 * 新方式の候補をmainへ出したあと、**本番で何が稼働しているか**の証拠を判定する（#4713）。
 *
 * 以前は`deploy.yml`に`APP_COMMIT_SHA`と`/api/app-version`の両方があるrepo（issue-deckだけ）しか候補を
 * 完了にできず、配布先repoは「前の候補が進行中」のまま次の候補を始められなかった。repoの種類ごとに方式を持つ。
 *
 * - `deploy_version_check`: deploy.ymlが稼働SHAを照合している（従来の判定）。deployジョブの成功がそのまま証拠
 * - `public_version_url`: 画面で登録した公開URLの版情報を、issue-deckが外から照合する（`sha`か`version`）
 * - `manual_attestation`: 人が確かめた内容を書いて確定する。外部照合が**旧版を返している間は確定できない**
 * - `source_publish`: deploy.ymlを持たずソースをReleaseで配るrepo（pi0w）。**ソース公開までを完了とし、実機配備は扱わない**
 * - `successor`: 照合の無い版の候補を、照合付きで稼働を確かめた後続の版（この候補を祖先に持つ）で確かめた（#4712）
 *
 * **HTTP 200・マージ済みだけでは完了にしない**（#4007・#4673）。deployするrepoでは、どの方式でも
 * 対象コミットのdeployが成功していることを前提にする。
 */

import { hasVersionCheck } from "@/lib/deploy-version-check";

export const PRODUCTION_TARGET_KINDS = ["deploy_version_check", "deploy_without_version_check", "source_publish_only", "unknown"] as const;
export type ProductionTargetKind = (typeof PRODUCTION_TARGET_KINDS)[number];

export const PRODUCTION_TARGET_LABEL: Record<ProductionTargetKind, string> = {
  deploy_version_check: "deploy.ymlが稼働SHAを照合する",
  deploy_without_version_check: "deploy.ymlは稼働SHAを照合しない（HTTP応答のみ）",
  source_publish_only: "ソースをReleaseで配布する（実機配備は別管理）",
  unknown: "本番反映の方式を判定できない",
};

export const PRODUCTION_VERIFICATION_METHODS = ["deploy_version_check", "public_version_url", "manual_attestation", "source_publish", "successor"] as const;
export type ProductionVerificationMethod = (typeof PRODUCTION_VERIFICATION_METHODS)[number];

export const PRODUCTION_METHOD_LABEL: Record<ProductionVerificationMethod, string> = {
  deploy_version_check: "deployの稼働SHA照合",
  public_version_url: "公開URLの版情報の照合",
  manual_attestation: "人による確認",
  source_publish: "ソース公開（Release資産）",
  successor: "後続の版の稼働SHA照合",
};

export const PRODUCTION_WAIT_REASONS = [
  "deploy_not_succeeded",
  "version_mismatch",
  "probe_unreadable",
  "no_evidence",
  "source_not_published",
  "unknown_target",
] as const;
export type ProductionWaitReason = (typeof PRODUCTION_WAIT_REASONS)[number];

export const PRODUCTION_WAIT_LABEL: Record<ProductionWaitReason, string> = {
  deploy_not_succeeded: "対象コミットのdeployが成功していません",
  version_mismatch: "公開URLが別の版を返しています（旧版が応答している可能性があります）",
  probe_unreadable: "公開URLから版情報を取得できません",
  no_evidence: "稼働版の証拠がありません。公開URLを登録するか、確かめた内容を書いて確定してください",
  source_not_published: "対象コミットのソース公開（Release）を確認できていません",
  unknown_target: "本番反映の方式を判定できません。確かめた内容を書いて確定してください",
};

/** 種類の判定。deploy.ymlの有無と中身、ソース配布のworkflowの有無だけを見る（対象コミット時点のファイル） */
export function classifyProductionTarget(input: { deployWorkflowText: string | null; releaseArtifactsWorkflowText: string | null }): ProductionTargetKind {
  const deploy = input.deployWorkflowText;
  if (deploy !== null) {
    return hasVersionCheck(deploy) ? "deploy_version_check" : "deploy_without_version_check";
  }
  return input.releaseArtifactsWorkflowText !== null ? "source_publish_only" : "unknown";
}

export type VersionProbeResult =
  | { status: "match"; by: "sha" | "version"; reported: string }
  | { status: "mismatch"; reportedSha: string | null; reportedVersion: string | null }
  | { status: "unreadable"; detail: string };

const SHA_FIELDS = ["sha", "commitSha", "commit"] as const;

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * 公開URLの応答を照合する。`sha`（`commitSha`・`commit`）があればSHAだけで判定し、版は見ない
 * （同じ版番号のまま中身が違うことはSHAでしか分からないため）。SHAが無いときだけ`version`を予約した版と比べる。
 * 短縮SHAは7文字以上で前方一致を認める
 */
export function evaluateVersionProbe(input: { httpStatus: number | null; body: string | null; mergeSha: string; version: string | null }): VersionProbeResult {
  if (input.httpStatus === null) return { status: "unreadable", detail: "応答がありません" };
  if (input.httpStatus < 200 || input.httpStatus >= 300) return { status: "unreadable", detail: `HTTP ${input.httpStatus}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body ?? "");
  } catch {
    return { status: "unreadable", detail: "JSONではありません" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: "unreadable", detail: "JSONのオブジェクトではありません" };
  const record = parsed as Record<string, unknown>;
  const sha = pickString(record, SHA_FIELDS);
  const version = pickString(record, ["version"]);
  if (sha !== null) {
    const reported = sha.toLowerCase();
    const expected = input.mergeSha.toLowerCase();
    const matches = reported === expected || (reported.length >= 7 && /^[0-9a-f]+$/.test(reported) && expected.startsWith(reported));
    return matches ? { status: "match", by: "sha", reported: sha } : { status: "mismatch", reportedSha: sha, reportedVersion: version };
  }
  if (version !== null) {
    if (input.version === null) return { status: "unreadable", detail: "照合する版が確定していません" };
    return version.replace(/^v/, "") === input.version.replace(/^v/, "")
      ? { status: "match", by: "version", reported: version }
      : { status: "mismatch", reportedSha: null, reportedVersion: version };
  }
  return { status: "unreadable", detail: "応答にsha・versionがありません" };
}

export type ProductionEvidenceInput = {
  kind: ProductionTargetKind;
  /** 対象コミットの最新のdeploy runが成功で終わったか（deployするrepoのみ意味を持つ） */
  deploySucceeded: boolean;
  /** deploy.ymlの稼働SHA照合を含むdeployジョブが成功したか */
  versionCheckPassed: boolean;
  /** 公開URLの照合結果。URLが未登録ならnull */
  probe: VersionProbeResult | null;
  /** 人が記録した確認。無ければnull */
  attested: boolean;
  /** ソース配布の観測（`source_publish_only`のみ） */
  sourcePublish: { runSucceeded: boolean; releasePublished: boolean } | null;
};

export type ProductionEvidenceDecision = { verified: true; method: ProductionVerificationMethod } | { verified: false; reason: ProductionWaitReason };

/** 稼働版の証拠が揃ったか。揃ったときは採用した方式を返す（判断はここだけで持つ） */
export function decideProductionEvidence(input: ProductionEvidenceInput): ProductionEvidenceDecision {
  if (input.kind === "source_publish_only") {
    return input.sourcePublish?.runSucceeded && input.sourcePublish.releasePublished
      ? { verified: true, method: "source_publish" }
      : { verified: false, reason: "source_not_published" };
  }
  if (input.kind === "unknown") {
    // deployの成否を観測しようがないrepo。人が確かめた内容を書いた場合だけ確定する
    return input.attested ? { verified: true, method: "manual_attestation" } : { verified: false, reason: "unknown_target" };
  }
  if (!input.deploySucceeded) return { verified: false, reason: "deploy_not_succeeded" };
  if (input.kind === "deploy_version_check" && input.versionCheckPassed) return { verified: true, method: "deploy_version_check" };
  if (input.probe?.status === "match") return { verified: true, method: "public_version_url" };
  // 外部照合が別の版を見ている間は、人の確認より機械の観測を優先する（旧版の応答を確認済みにしない）
  if (input.probe?.status === "mismatch") return { verified: false, reason: "version_mismatch" };
  if (input.attested) return { verified: true, method: "manual_attestation" };
  return { verified: false, reason: input.probe?.status === "unreadable" ? "probe_unreadable" : "no_evidence" };
}

/** 人の確認を受け付けてよいか。deployするrepoでは対象コミットのdeploy成功が前提 */
export function canAttestProduction(input: { kind: ProductionTargetKind; deploySucceeded: boolean; phase: string }): boolean {
  if (!["deploying", "verifying_production"].includes(input.phase)) return false;
  if (input.kind === "source_publish_only") return false;
  if (input.kind === "unknown") return true;
  return input.deploySucceeded;
}

export const PRODUCTION_ATTESTATION_NOTE_MIN = 10;
export const PRODUCTION_ATTESTATION_NOTE_MAX = 2000;

/** 確認内容の検証。何で確かめたかが読める長さを求める */
export function parseAttestationNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim();
  return note.length >= PRODUCTION_ATTESTATION_NOTE_MIN && note.length <= PRODUCTION_ATTESTATION_NOTE_MAX ? note : null;
}

/**
 * 公開URLの検証。issue-deckのサーバーから取りに行くため、`https`の公開ホスト名だけを受け付ける
 * （IPアドレス直書き・localhost・tailnet内の名前は拒否して、内部への到達に使わせない）
 */
export function parseVersionEndpointUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".ts.net")) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  return url.toString();
}
