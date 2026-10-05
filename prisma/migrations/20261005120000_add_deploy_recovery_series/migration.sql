-- AlterTable
ALTER TABLE `PullRequestAutoRepairLoop` ADD COLUMN `maxRounds` INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE `DeployRecoverySeries` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `environment` VARCHAR(191) NOT NULL DEFAULT 'production',
    `failedRunId` BIGINT NOT NULL,
    `failedRunAttempt` INTEGER NOT NULL,
    `failedSha` VARCHAR(191) NOT NULL,
    `failedRunUrl` TEXT NOT NULL,
    `failedVersion` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `activeKey` VARCHAR(191) NULL,
    `startedByUserId` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `issueNumber` INTEGER NULL,
    `dispatchJobId` VARCHAR(191) NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `cause` VARCHAR(191) NULL,
    `pullRequestNumber` INTEGER NULL,
    `repairRoundsBase` INTEGER NOT NULL DEFAULT 0,
    `repairRoundsUsed` INTEGER NOT NULL DEFAULT 0,
    `stopReason` VARCHAR(191) NULL,
    `stopDetail` TEXT NULL,
    `stoppedByUserId` VARCHAR(191) NULL,
    `stoppedAt` DATETIME(3) NULL,
    `lastSweepAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DeployRecoverySeries_activeKey_key`(`activeKey`),
    INDEX `DeployRecoverySeries_status_idx`(`status`),
    INDEX `DeployRecoverySeries_repositoryFullName_createdAt_idx`(`repositoryFullName`, `createdAt`),
    UNIQUE INDEX `DeployRecoverySeries_failure_key`(`repositoryFullName`, `environment`, `failedRunId`, `failedRunAttempt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
