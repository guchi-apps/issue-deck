CREATE TABLE `PullRequestAutoRepairLoop` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `pullRequestNumber` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `headSha` VARCHAR(191) NOT NULL,
    `round` INTEGER NOT NULL DEFAULT 0,
    `currentKind` VARCHAR(191) NULL,
    `lastFingerprint` VARCHAR(191) NULL,
    `stopReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PullRequestAutoRepairLoop_repositoryFullName_pullRequestNumber_key`(`repositoryFullName`, `pullRequestNumber`),
    INDEX `PullRequestAutoRepairLoop_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
