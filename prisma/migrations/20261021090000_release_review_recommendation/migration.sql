
-- AlterTable
ALTER TABLE `ReleaseReviewDecision` ADD COLUMN `reasonSource` VARCHAR(16) NULL,
    ADD COLUMN `recommendationId` VARCHAR(40) NULL,
    ADD COLUMN `recommendedDecision` VARCHAR(32) NULL,
    ADD COLUMN `recommendedReason` TEXT NULL;

-- CreateTable
CREATE TABLE `ReleaseReviewRecommendation` (
    `id` VARCHAR(191) NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `prNumber` INTEGER NOT NULL,
    `baseSha` VARCHAR(64) NOT NULL,
    `headSha` VARCHAR(64) NOT NULL,
    `findingId` VARCHAR(32) NOT NULL,
    `severity` VARCHAR(16) NOT NULL,
    `blocking` BOOLEAN NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `recommended` VARCHAR(32) NULL,
    `rationale` TEXT NULL,
    `drafts` JSON NULL,
    `missing` JSON NULL,
    `error` VARCHAR(500) NULL,
    `model` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReleaseReviewRecommendation_scopeKey_idx`(`scopeKey`),
    UNIQUE INDEX `ReleaseReviewRecommendation_target_key`(`scopeKey`, `baseSha`, `headSha`, `findingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

