import type { BackupCiRun } from "@prisma/client";

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
    startedByUserId: run.startedByUserId,
    requestedAt: run.requestedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
