-- AlterTable
ALTER TABLE `AppSetting`
    ADD COLUMN `dispatchConcurrency` INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE `DispatchJob` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `targetHost` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELED') NOT NULL DEFAULT 'QUEUED',
    `activeKey` VARCHAR(191) NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `claimedByHost` VARCHAR(191) NULL,
    `claimedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `heartbeatAt` DATETIME(3) NULL,
    `tmuxSessionName` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DispatchJob_activeKey_key`(`activeKey`),
    INDEX `DispatchJob_status_idx`(`status`),
    INDEX `DispatchJob_targetHost_status_idx`(`targetHost`, `status`),
    INDEX `DispatchJob_repositoryFullName_issueNumber_idx`(`repositoryFullName`, `issueNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DispatchHost` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `repositories` TEXT NOT NULL,
    `contractVersion` INTEGER NULL,
    `maxConcurrency` INTEGER NULL,
    `agentVersion` VARCHAR(191) NULL,
    `lastSeenAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DispatchHost_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
