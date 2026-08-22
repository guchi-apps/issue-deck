-- CreateTable
-- ローカル・サブPC実行のセッションが公開したアーティファクト（#2154）。
-- claude.aiのページはframe-ancestors 'self'で埋め込めないため、公開時にHTMLの原本を
-- 受け取ってissue-deck自身のオリジンから出す。1Issue×1ソースファイルにつき1行を上書きする。
CREATE TABLE `SessionArtifact` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `hostName` VARCHAR(191) NULL,
    `title` TEXT NOT NULL,
    `description` TEXT NULL,
    `favicon` VARCHAR(191) NULL,
    `claudeUrl` TEXT NULL,
    `sourcePath` TEXT NOT NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `storedFilename` VARCHAR(191) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SessionArtifact_repositoryFullName_issueNumber_idx`(`repositoryFullName`, `issueNumber`),
    UNIQUE INDEX `SessionArtifact_repositoryFullName_issueNumber_sourceKey_key`(`repositoryFullName`, `issueNumber`, `sourceKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
