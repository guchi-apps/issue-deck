import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { DeployRunObservation } from "@/lib/deploy-recovery-series";
import { fetchDeployRunsForSha, fetchWorkflowRunsForSha, hasVersionVerification } from "@/lib/deploy-recovery-series-run";
import { fetchFileTextAtRef } from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { fetchPublicHttps } from "@/lib/public-http-fetch";
import {
  canAttestProduction,
  classifyProductionTarget,
  decideProductionEvidence,
  evaluateVersionProbe,
  PRODUCTION_METHOD_LABEL,
  PRODUCTION_TARGET_KINDS,
  PRODUCTION_TARGET_LABEL,
  PRODUCTION_VERIFICATION_METHODS,
  PRODUCTION_WAIT_LABEL,
  PRODUCTION_WAIT_REASONS,
  type ProductionEvidenceDecision,
  type ProductionTargetKind,
  type ProductionVerificationMethod,
  type ProductionWaitReason,
  type VersionProbeResult,
} from "@/lib/release-production-verification";
import type { Context } from "@/lib/release-rc-run";

/**
 * 新方式の候補の稼働版の確認（#4713）。観測と記録だけを持ち、判断は`decideProductionEvidence`に任せる。
 * 本番反映の進行（`advanceProduction`）が巡回・画面の読み込みのたびに呼ぶ。
 */

const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
// deploy.ymlを持たずソースをReleaseで配るrepo（pi0w）のworkflow。実機配備はこのworkflowの外（pi0w#9）
const SOURCE_PUBLISH_WORKFLOW = "release-artifacts.yml";
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_BODY_LIMIT = 64 * 1024;

const fullNameOf = (ctx: Context) => `${ctx.owner}/${ctx.repo}`;

export type ProductionObservation = {
  kind: ProductionTargetKind;
  /** deployするrepoでは対象コミットのdeploy run（従来の本番反映の判定へそのまま渡す）。ソース配布では空 */
  runs: DeployRunObservation[];
  decision: ProductionEvidenceDecision;
  /** 完了にしたときに残す証拠 */
  evidence: Record<string, unknown>;
};

function latestRun(runs: DeployRunObservation[]): DeployRunObservation | null {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0] ?? null;
}

const succeeded = (run: DeployRunObservation | null) => run?.status === "completed" && run.conclusion === "success";

/** 公開URLを取りに行く。リダイレクトは追わず、公開アドレスへ解決される場合だけ接続する（内部ネットワークへ到達させない。#4719） */
async function fetchVersionEndpoint(url: string): Promise<{ httpStatus: number | null; body: string | null }> {
  try {
    return await fetchPublicHttps(url, { timeoutMs: PROBE_TIMEOUT_MS, bodyLimit: PROBE_BODY_LIMIT });
  } catch {
    return { httpStatus: null, body: null };
  }
}

/** 正式版のReleaseが公開済み（下書きでない）で、タグが対象コミットを指しているか */
async function fetchPublishedRelease(ctx: Context, version: string | null, mergeSha: string): Promise<{ published: boolean; url: string | null }> {
  if (version === null) return { published: false, url: null };
  const res = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/releases/tags/${encodeURIComponent(`v${version}`)}`, ctx.token);
  if (!res.ok) return { published: false, url: null };
  const release: { draft?: boolean; html_url?: string; target_commitish?: string } = await res.json();
  if (release.draft !== false) return { published: false, url: release.html_url ?? null };
  const ref = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/commits/${encodeURIComponent(`v${version}`)}`, ctx.token);
  if (!ref.ok) return { published: false, url: release.html_url ?? null };
  const commit: { sha?: string } = await ref.json();
  return { published: commit.sha === mergeSha, url: release.html_url ?? null };
}

/**
 * 候補の稼働版の証拠を観測し、記録（`ReleaseProductionCheck`）を更新する。完了にするかは呼び出し側が
 * 戻り値の`decision`と従来の本番反映の判定で決め、完了にしたら`recordProductionVerified`を呼ぶ
 */
export async function observeProduction(ctx: Context, input: { candidateId: string; mergeSha: string; version: string | null }): Promise<ProductionObservation> {
  const { candidateId, mergeSha, version } = input;
  const deployText = await fetchFileTextAtRef(ctx.owner, ctx.repo, DEPLOY_WORKFLOW_PATH, mergeSha, ctx.token);
  const sourceText = deployText === null ? await fetchFileTextAtRef(ctx.owner, ctx.repo, `.github/workflows/${SOURCE_PUBLISH_WORKFLOW}`, mergeSha, ctx.token) : null;
  const kind = classifyProductionTarget({ deployWorkflowText: deployText, releaseArtifactsWorkflowText: sourceText });
  const existing = await db.releaseProductionCheck.findUnique({ where: { candidateId } });
  const attested = existing?.attestedAt != null && existing.mergeSha === mergeSha;

  let runs: DeployRunObservation[] = [];
  let latest: DeployRunObservation | null = null;
  let versionCheckPassed = false;
  let probe: (VersionProbeResult & { url: string; at: string }) | null = null;
  let sourcePublish: { runSucceeded: boolean; releasePublished: boolean } | null = null;
  const evidence: Record<string, unknown> = { mergeSha };

  if (kind === "source_publish_only") {
    runs = [];
    const sourceRuns = await fetchWorkflowRunsForSha(ctx.owner, ctx.repo, SOURCE_PUBLISH_WORKFLOW, mergeSha, ctx.token).catch(() => []);
    latest = latestRun(sourceRuns);
    const release = succeeded(latest) ? await fetchPublishedRelease(ctx, version, mergeSha) : { published: false, url: null };
    sourcePublish = { runSucceeded: succeeded(latest), releasePublished: release.published };
    Object.assign(evidence, { sourceRunUrl: latest?.htmlUrl ?? null, releaseUrl: release.url, deviceDeployment: "out_of_scope" });
  } else if (kind !== "unknown") {
    runs = await fetchDeployRunsForSha(ctx.owner, ctx.repo, mergeSha, ctx.token);
    latest = latestRun(runs);
    if (succeeded(latest)) {
      versionCheckPassed = kind === "deploy_version_check" && (await hasVersionVerification(ctx.owner, ctx.repo, latest!, ctx.token));
      if (!versionCheckPassed) {
        const endpoint = await db.releaseVersionEndpoint.findUnique({ where: { repositoryFullName: fullNameOf(ctx) } });
        if (endpoint) {
          const response = await fetchVersionEndpoint(endpoint.url);
          probe = { ...evaluateVersionProbe({ ...response, mergeSha, version }), url: endpoint.url, at: new Date().toISOString() };
        }
      }
    }
    Object.assign(evidence, { deployRunUrl: latest?.htmlUrl ?? null, probe });
  }

  const decision = decideProductionEvidence({ kind, deploySucceeded: succeeded(latest), versionCheckPassed, probe, attested, sourcePublish });
  const data = {
    repositoryFullName: fullNameOf(ctx),
    mergeSha,
    targetKind: kind,
    deploySucceeded: succeeded(latest),
    deployRunUrl: latest?.htmlUrl ?? null,
    lastProbe: probe ?? undefined,
    waitingReason: decision.verified ? null : decision.reason,
    lastObservedAt: new Date(),
  };
  if (existing) {
    // 完了の記録（method・evidence）は書き換えない。観測した事実だけを更新する（照合しなかった巡回は直前の照合結果を残す）
    await db.releaseProductionCheck.update({ where: { candidateId }, data });
  } else {
    await db.releaseProductionCheck.create({ data: { candidateId, ...data } }).catch((error: unknown) => {
      // 同時の巡回が先に作った場合は、そちらの記録を使う
      console.error("[release-production] 確認の記録を作れませんでした", candidateId, error);
    });
  }
  if (decision.verified && decision.method === "manual_attestation") {
    Object.assign(evidence, { attestedByUserId: existing?.attestedByUserId ?? null, attestationNote: existing?.attestationNote ?? null });
  }
  return { kind, runs, decision, evidence };
}

/** 候補を完了にした根拠を残す。一度残した根拠は書き換えない */
export async function recordProductionVerified(candidateId: string, method: ProductionVerificationMethod, evidence: Record<string, unknown>): Promise<void> {
  await db.releaseProductionCheck.updateMany({
    where: { candidateId, method: null },
    data: { method, evidence: evidence as object, verifiedAt: new Date(), waitingReason: null },
  });
}

/**
 * 候補側でこのマージコミットの稼働版を確認済みか（リリース完了系列が同じ証拠を使うため）。
 * 系列の追跡はdeploy.ymlの照合しか見ないので、それが無いrepoでは候補の確認結果に揃える
 */
export async function isProductionVerifiedForMergeSha(repositoryFullName: string, mergeSha: string): Promise<boolean> {
  const row = await db.releaseProductionCheck.findFirst({ where: { repositoryFullName, mergeSha, method: { not: null } }, select: { id: true } });
  return row !== null;
}

export type AttestProductionResult = { ok: true } | { ok: false; error: "not_found" | "not_attestable" | "stale_target" | "already_attested" };

/**
 * 人の確認を記録する（#4713）。**記録しただけでは完了にしない。** 呼び出し側が本番反映の進行を1巡回し、
 * 公開URLが旧版を返していないことなどを`decideProductionEvidence`が確かめてから完了にする
 */
export async function attestProduction(input: { candidateId: string; expectedMergeSha: string; userId: string; note: string }): Promise<AttestProductionResult> {
  const candidate = await db.releaseCandidate.findUnique({ where: { id: input.candidateId }, select: { phase: true } });
  const check = await db.releaseProductionCheck.findUnique({ where: { candidateId: input.candidateId } });
  if (!candidate || !check) return { ok: false, error: "not_found" };
  if (check.mergeSha !== input.expectedMergeSha) return { ok: false, error: "stale_target" };
  if (check.attestedAt) return { ok: false, error: "already_attested" };
  const kind = parseKind(check.targetKind);
  if (!canAttestProduction({ kind, deploySucceeded: check.deploySucceeded, phase: candidate.phase })) return { ok: false, error: "not_attestable" };
  const updated = await db.releaseProductionCheck.updateMany({
    where: { candidateId: input.candidateId, mergeSha: input.expectedMergeSha, attestedAt: null },
    data: { attestedByUserId: input.userId, attestationNote: input.note, attestedAt: new Date() },
  });
  return updated.count === 1 ? { ok: true } : { ok: false, error: "already_attested" };
}

/** 公開URLの登録・削除。URLの検証は呼び出し側（`parseVersionEndpointUrl`）で済ませる */
export async function saveVersionEndpoint(repositoryFullName: string, url: string | null, userId: string): Promise<void> {
  if (url === null) {
    await db.releaseVersionEndpoint.deleteMany({ where: { repositoryFullName } });
    // 消したURLの照合結果を、完了していない候補の画面に残さない
    await db.releaseProductionCheck.updateMany({ where: { repositoryFullName, method: null }, data: { lastProbe: Prisma.DbNull } });
    return;
  }
  await db.releaseVersionEndpoint.upsert({
    where: { repositoryFullName },
    create: { repositoryFullName, url, updatedByUserId: userId },
    update: { url, updatedByUserId: userId },
  });
}

// ---------------------------------------------------------------------------
// 画面に出す形

export type RcProductionView = {
  mergeSha: string;
  targetKind: ProductionTargetKind;
  targetLabel: string;
  deploySucceeded: boolean;
  deployRunUrl: string | null;
  waitingReason: ProductionWaitReason | null;
  waitingLabel: string | null;
  method: ProductionVerificationMethod | null;
  methodLabel: string | null;
  verifiedAt: string | null;
  probe: { url: string; status: VersionProbeResult["status"]; detail: string; at: string } | null;
  endpointUrl: string | null;
  attestation: { byUserId: string | null; note: string; at: string } | null;
  canAttest: boolean;
  lastObservedAt: string | null;
};

function parseKind(value: string): ProductionTargetKind {
  return (PRODUCTION_TARGET_KINDS as readonly string[]).includes(value) ? (value as ProductionTargetKind) : "unknown";
}

function describeProbe(probe: VersionProbeResult): string {
  if (probe.status === "match") return `${probe.by === "sha" ? "SHA" : "版"} ${probe.reported} が一致しました`;
  if (probe.status === "mismatch") return `別の版が応答しました（${[probe.reportedSha && `sha=${probe.reportedSha}`, probe.reportedVersion && `version=${probe.reportedVersion}`].filter(Boolean).join(" ")}）`;
  return probe.detail;
}

function parseProbe(value: unknown): RcProductionView["probe"] {
  if (typeof value !== "object" || value === null) return null;
  const probe = value as VersionProbeResult & { url?: unknown; at?: unknown };
  if (typeof probe.url !== "string" || typeof probe.at !== "string" || !["match", "mismatch", "unreadable"].includes(probe.status)) return null;
  return { url: probe.url, status: probe.status, detail: describeProbe(probe), at: probe.at };
}

/** 候補の稼働版の確認（画面用）。GitHubは呼ばず、巡回が残した記録だけを読む */
export async function loadProductionView(repositoryFullName: string, candidateId: string, phase: string): Promise<RcProductionView | null> {
  const [check, endpoint] = await Promise.all([
    db.releaseProductionCheck.findUnique({ where: { candidateId } }),
    db.releaseVersionEndpoint.findUnique({ where: { repositoryFullName } }),
  ]);
  if (!check) return null;
  const kind = parseKind(check.targetKind);
  const waiting = (PRODUCTION_WAIT_REASONS as readonly string[]).includes(check.waitingReason ?? "") ? (check.waitingReason as ProductionWaitReason) : null;
  const method = (PRODUCTION_VERIFICATION_METHODS as readonly string[]).includes(check.method ?? "") ? (check.method as ProductionVerificationMethod) : null;
  return {
    mergeSha: check.mergeSha,
    targetKind: kind,
    targetLabel: PRODUCTION_TARGET_LABEL[kind],
    deploySucceeded: check.deploySucceeded,
    deployRunUrl: check.deployRunUrl,
    waitingReason: method ? null : waiting,
    waitingLabel: method || !waiting ? null : PRODUCTION_WAIT_LABEL[waiting],
    method,
    methodLabel: method ? PRODUCTION_METHOD_LABEL[method] : null,
    verifiedAt: check.verifiedAt?.toISOString() ?? null,
    probe: parseProbe(check.lastProbe),
    endpointUrl: endpoint?.url ?? null,
    attestation: check.attestedAt && check.attestationNote ? { byUserId: check.attestedByUserId, note: check.attestationNote, at: check.attestedAt.toISOString() } : null,
    canAttest: !check.attestedAt && canAttestProduction({ kind, deploySucceeded: check.deploySucceeded, phase }),
    lastObservedAt: check.lastObservedAt?.toISOString() ?? null,
  };
}
