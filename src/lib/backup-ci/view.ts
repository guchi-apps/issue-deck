import type { BackupCiRun, CiGateState } from "@prisma/client";

import { CI_GATE_SOURCE_LABELS, parseCiGateSource } from "@/lib/backup-ci/gate";
import { BACKUP_CI_MERGE_STATUS_LABELS, parseBackupCiMergeStatus } from "@/lib/backup-ci/merge";

import {
  BACKUP_CI_STATUS_LABELS,
  type BackupCiCheckResult,
  type BackupCiDisplayKind,
  backupCiDisplayKind,
  parseBackupCiRunStatus,
} from "@/lib/backup-ci/state";

/** 画面へ返すバックアップCIの実行1件（#4065） */
export type BackupCiRunView = {
  id: string;
  attempt: number;
  provider: string;
  status: string;
  statusLabel: string;
  displayKind: BackupCiDisplayKind;
  statusReason: string | null;
  headSha: string;
  baseSha: string;
  testedSha: string | null;
  definitionDigest: string | null;
  externalPipelineId: string | null;
  externalPipelineNumber: number | null;
  logUrl: string | null;
  checks: BackupCiCheckResult[];
  gateState: string | null;
  /** 合格後のdevelopへのマージの進み具合（#4114）。未着手ならnull */
  mergeStatus: string | null;
  mergeStatusLabel: string | null;
  mergeReason: string | null;
  mergeCommitSha: string | null;
  startedByUserId: string;
  requestedAt: string;
  completedAt: string | null;
};

export function toBackupCiRunView(run: BackupCiRun): BackupCiRunView {
  const status = parseBackupCiRunStatus(run.status) ?? "unverifiable";
  let checks: BackupCiCheckResult[] = [];
  try {
    const parsed: unknown = run.checksJson ? JSON.parse(run.checksJson) : [];
    if (Array.isArray(parsed)) checks = parsed as BackupCiCheckResult[];
  } catch {
    checks = [];
  }
  return {
    id: run.id,
    attempt: run.attempt,
    provider: run.provider,
    status,
    statusLabel: BACKUP_CI_STATUS_LABELS[status],
    displayKind: backupCiDisplayKind(status),
    statusReason: run.statusReason,
    headSha: run.headSha,
    baseSha: run.baseSha,
    testedSha: run.testedSha,
    definitionDigest: run.definitionDigest,
    externalPipelineId: run.externalPipelineId,
    externalPipelineNumber: run.externalPipelineNumber,
    logUrl: run.logUrl,
    checks,
    gateState: run.gateState,
    mergeStatus: parseBackupCiMergeStatus(run.mergeStatus),
    mergeStatusLabel: (() => {
      const mergeStatus = parseBackupCiMergeStatus(run.mergeStatus);
      return mergeStatus ? BACKUP_CI_MERGE_STATUS_LABELS[mergeStatus] : null;
    })(),
    mergeReason: run.mergeReason,
    mergeCommitSha: run.mergeCommitSha,
    startedByUserId: run.startedByUserId,
    requestedAt: run.requestedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/** 画面へ返す共通チェックの採用状況（#4113）。どちらの経路の結果を出しているか */
export type CiGateStateView = {
  source: string;
  sourceLabel: string;
  state: string;
  description: string;
  headSha: string;
  baseSha: string;
  /** 発行に失敗していれば`publish_failed:<code>` */
  publishFailure: string | null;
  lastEvaluatedAt: string;
};

export function toCiGateStateView(gate: CiGateState): CiGateStateView {
  const source = parseCiGateSource(gate.source);
  return {
    source: gate.source,
    sourceLabel: source ? CI_GATE_SOURCE_LABELS[source] : gate.source,
    state: gate.state,
    description: gate.description,
    headSha: gate.headSha,
    baseSha: gate.baseSha,
    publishFailure: gate.publishedState?.startsWith("publish_failed") ? gate.publishedState : null,
    lastEvaluatedAt: gate.lastEvaluatedAt.toISOString(),
  };
}
