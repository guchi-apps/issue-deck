-- CreateTable
-- PRの自動修復（claude-ci-fix / claude-conflict-resolve / claude-pr-repair）が
-- いま走っているかどうか（#2072）。1PR×1種別につき1行を上書きする。
CREATE TABLE `PullRequestRepairRun` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `pullRequestNumber` INTEGER NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `runUrl` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PullRequestRepairRun_status_idx`(`status`),
    UNIQUE INDEX `PullRequestRepairRun_repositoryFullName_pullRequestNumber_ki_key`(`repositoryFullName`, `pullRequestNumber`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
