-- CreateTable
CREATE TABLE `PullRequestReviewStallRescue` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `pullRequestNumber` INTEGER NOT NULL,
    `headSha` VARCHAR(191) NOT NULL,
    `headAttempts` INTEGER NOT NULL DEFAULT 0,
    `totalAttempts` INTEGER NOT NULL DEFAULT 0,
    `lastAttemptAt` DATETIME(3) NULL,
    `notifiedHeadSha` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PullRequestReviewStallRescue_repo_pr_key`(`repositoryFullName`, `pullRequestNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
