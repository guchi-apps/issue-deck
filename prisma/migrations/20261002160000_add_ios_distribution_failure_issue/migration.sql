-- CreateTable
-- iOS配布（ios-testflight.yml）の失敗を追跡するために自動起票したIssue（#3745）。
-- 持つのは「起票したかどうか」だけで、失敗そのものの正はGitHubのrun。
-- 二重起票の防止は (repositoryFullName, runId) の一意キーで行う。
CREATE TABLE `IosDistributionFailureIssue` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `runId` BIGINT NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'open',
    `failedStage` VARCHAR(191) NULL,
    `runUrl` TEXT NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `IosDistributionFailureIssue_repositoryFullName_state_idx`(`repositoryFullName`, `state`),
    UNIQUE INDEX `IosDistributionFailureIssue_repositoryFullName_runId_key`(`repositoryFullName`, `runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
