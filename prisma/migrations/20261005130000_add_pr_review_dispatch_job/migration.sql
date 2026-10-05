-- develop向けPRのAIレビューをDispatchJobで管理する（#3990）。
ALTER TABLE `DispatchJob`
  MODIFY `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW', 'SELF_UPDATE', 'CODE_REVIEW', 'PREVIEW', 'REBOOT', 'CODEX_PAIRING', 'MANUAL_STEP_SESSION', 'PR_REVIEW') NOT NULL DEFAULT 'LAUNCH',
  ADD COLUMN `prNumber` INTEGER NULL,
  ADD COLUMN `baseSha` VARCHAR(64) NULL,
  ADD COLUMN `headSha` VARCHAR(64) NULL,
  ADD COLUMN `reviewVerdict` VARCHAR(32) NULL,
  ADD COLUMN `workflowRunId` VARCHAR(32) NULL,
  ADD COLUMN `mergeResumedAt` DATETIME(3) NULL,
  ADD COLUMN `mergeResumeAttempts` INTEGER NOT NULL DEFAULT 0;

CREATE INDEX `DispatchJob_kind_status_mergeResumedAt_idx` ON `DispatchJob`(`kind`, `status`, `mergeResumedAt`);
CREATE INDEX `DispatchJob_repositoryFullName_prNumber_headSha_idx` ON `DispatchJob`(`repositoryFullName`, `prNumber`, `headSha`);

ALTER TABLE `DispatchHost` ADD COLUMN `prReviewCapable` BOOLEAN NULL;
