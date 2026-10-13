-- AlterTable
ALTER TABLE `ReleaseFixFinding` ADD COLUMN `regressionCount` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `ReleaseFixInternalSession` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `activeSeconds` INTEGER NOT NULL DEFAULT 0,
    `lastActivityAt` DATETIME(3) NULL,
    `budgetMinutes` INTEGER NOT NULL DEFAULT 120,
    `pauseKind` VARCHAR(32) NULL,
    `pauseDetail` TEXT NULL,
    `pausedAt` DATETIME(3) NULL,
    `pausedSha` VARCHAR(64) NULL,
    `resumeBaseRound` INTEGER NOT NULL DEFAULT 0,
    `nextAction` TEXT NULL,
    `assignee` VARCHAR(120) NULL,
    `assignmentEpoch` INTEGER NOT NULL DEFAULT 0,
    `leaseUntil` DATETIME(3) NULL,
    `attempts` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseFixInternalSession_repositoryFullName_issueNumber_key`(`repositoryFullName`, `issueNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
