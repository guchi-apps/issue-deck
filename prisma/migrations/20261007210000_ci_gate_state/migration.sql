-- AlterTable
ALTER TABLE `BackupCiSetting` ADD COLUMN `mirrorActionsToCiGate` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `CiGateState` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `prNumber` INTEGER NOT NULL,
    `headSha` VARCHAR(191) NOT NULL,
    `baseSha` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `sourceRef` VARCHAR(191) NULL,
    `sourceStartedAt` DATETIME(3) NULL,
    `state` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `targetUrl` TEXT NULL,
    `publishedState` VARCHAR(191) NULL,
    `lastEvaluatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CiGateState_lastEvaluatedAt_idx`(`lastEvaluatedAt`),
    UNIQUE INDEX `CiGateState_repositoryFullName_prNumber_key`(`repositoryFullName`, `prNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
