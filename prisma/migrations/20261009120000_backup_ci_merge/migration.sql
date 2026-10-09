-- AlterTable
ALTER TABLE `BackupCiRun` ADD COLUMN `mergeStatus` VARCHAR(191) NULL,
    ADD COLUMN `mergeReason` TEXT NULL,
    ADD COLUMN `reviewJobId` VARCHAR(191) NULL,
    ADD COLUMN `mergeAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `mergeCommitSha` VARCHAR(191) NULL,
    ADD COLUMN `mergeDecidedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `BackupCiRun_status_mergeStatus_idx` ON `BackupCiRun`(`status`, `mergeStatus`);
