
-- CreateTable
CREATE TABLE `ReleaseReviewDecision` (
    `id` VARCHAR(191) NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `findingId` VARCHAR(32) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `decision` VARCHAR(32) NOT NULL,
    `reason` TEXT NOT NULL,
    `impact` TEXT NULL,
    `scope` TEXT NULL,
    `followUpRepo` VARCHAR(191) NULL,
    `followUpNumber` INTEGER NULL,
    `timing` VARCHAR(500) NULL,
    `prNumber` INTEGER NOT NULL,
    `headRef` VARCHAR(191) NOT NULL,
    `baseSha` VARCHAR(64) NOT NULL,
    `headSha` VARCHAR(64) NOT NULL,
    `severity` VARCHAR(16) NOT NULL,
    `blocking` BOOLEAN NOT NULL,
    `findingTitle` VARCHAR(300) NOT NULL,
    `decidedByUserId` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReleaseReviewDecision_scopeKey_idx`(`scopeKey`),
    UNIQUE INDEX `ReleaseReviewDecision_sequence_key`(`scopeKey`, `findingId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

