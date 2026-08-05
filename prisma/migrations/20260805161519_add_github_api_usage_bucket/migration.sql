-- CreateTable
CREATE TABLE `GithubApiUsageBucket` (
    `id` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `feature` VARCHAR(191) NOT NULL,
    `endpoint` VARCHAR(191) NOT NULL,
    `count` INTEGER NOT NULL,

    INDEX `GithubApiUsageBucket_startedAt_idx`(`startedAt`),
    UNIQUE INDEX `GithubApiUsageBucket_startedAt_feature_endpoint_key`(`startedAt`, `feature`, `endpoint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
