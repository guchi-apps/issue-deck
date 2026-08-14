-- CreateTable
-- 1Password → GitHub のシークレット同期の実行履歴（#1309）。
-- 保存するのは件数と失敗した項目名だけで、値そのもの・値の長さは持たない。
CREATE TABLE `SecretSyncRun` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `only` VARCHAR(191) NOT NULL DEFAULT '',
    `status` ENUM('QUEUED', 'SUCCEEDED', 'FAILED', 'TIMEOUT') NOT NULL DEFAULT 'QUEUED',
    `requestedByUserId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `syncedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `failedKeys` TEXT NOT NULL,
    `runUrl` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SecretSyncRun_repositoryFullName_startedAt_idx`(`repositoryFullName`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
