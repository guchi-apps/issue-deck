-- CreateTable
-- サブPCのローカルセッション1本（＝転記ファイル1つ）が使ったトークン（#2504）。
-- 本番のissue-deck（VPS）は転記を読めないため、pollerが集計した数値だけをここへ押し込む。
-- 1行＝転記1本で、走っている間は同じ行を上書きし続ける（`host` + `sessionId` で一意）。
CREATE TABLE `SessionUsage` (
    `id` VARCHAR(191) NOT NULL,
    `host` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `transcript` TEXT NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `repository` VARCHAR(191) NULL,
    `issueNumber` INTEGER NULL,
    `responses` INTEGER NOT NULL,
    `inputTokens` BIGINT NOT NULL,
    `cacheCreate5mTokens` BIGINT NOT NULL,
    `cacheCreate1hTokens` BIGINT NOT NULL,
    `cacheReadTokens` BIGINT NOT NULL,
    `outputTokens` BIGINT NOT NULL,
    `costUsd` DOUBLE NOT NULL,
    `models` TEXT NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NOT NULL,
    `reportedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionUsage_host_sessionId_key`(`host`, `sessionId`),
    INDEX `SessionUsage_endedAt_idx`(`endedAt`),
    INDEX `SessionUsage_repository_issueNumber_idx`(`repository`, `issueNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
