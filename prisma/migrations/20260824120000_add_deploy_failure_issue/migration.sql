-- CreateTable
-- 本番デプロイ（deploy.yml）の失敗を追跡するために自動起票したIssue（#2236）。
-- 持つのは「起票したかどうか」だけで、失敗そのものの正はGitHubのrun。
-- 二重起票の防止は (repositoryFullName, runId) の一意キーで行う。
CREATE TABLE `DeployFailureIssue` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `runId` BIGINT NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'open',
    `version` VARCHAR(191) NULL,
    `runUrl` TEXT NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DeployFailureIssue_repositoryFullName_state_idx`(`repositoryFullName`, `state`),
    UNIQUE INDEX `DeployFailureIssue_repositoryFullName_runId_key`(`repositoryFullName`, `runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
