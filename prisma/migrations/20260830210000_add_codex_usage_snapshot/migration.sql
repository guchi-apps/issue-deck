-- Codex CLIのプラン枠を、実行ホストからIssueDeckへ報告する（#2535）。
CREATE TABLE `CodexUsageSnapshot` (
    `host` VARCHAR(191) NOT NULL,
    `primaryUsedPercent` DOUBLE NOT NULL,
    `primaryWindowMinutes` INTEGER NOT NULL,
    `primaryResetsAt` DATETIME(3) NOT NULL,
    `secondaryUsedPercent` DOUBLE NOT NULL,
    `secondaryWindowMinutes` INTEGER NOT NULL,
    `secondaryResetsAt` DATETIME(3) NOT NULL,
    `planType` VARCHAR(64) NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `reportedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CodexUsageSnapshot_observedAt_idx`(`observedAt`),
    PRIMARY KEY (`host`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
