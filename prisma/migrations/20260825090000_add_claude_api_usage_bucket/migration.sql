-- CreateTable
-- issue-deck自身が投げたAnthropic API（/v1/messages）の消費を機能別・モデル別に保持する（#2347）。
-- 正はプロセス内メモリ（src/lib/claude/api-usage.ts）で、この表は再起動をまたいで
-- 直近7日ぶんを引き継ぐためだけに使う。
CREATE TABLE `ClaudeApiUsageBucket` (
    `id` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `feature` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `calls` INTEGER NOT NULL,
    `inputTokens` INTEGER NOT NULL,
    `outputTokens` INTEGER NOT NULL,
    `cacheReadTokens` INTEGER NOT NULL,
    `cacheCreationTokens` INTEGER NOT NULL,

    INDEX `ClaudeApiUsageBucket_startedAt_idx`(`startedAt`),
    UNIQUE INDEX `ClaudeApiUsageBucket_startedAt_feature_model_key`(`startedAt`, `feature`, `model`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
