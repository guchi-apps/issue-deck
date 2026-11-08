-- CreateTable
CREATE TABLE `ReleaseReviewNote` (
    `id` VARCHAR(191) NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `targetKind` VARCHAR(16) NOT NULL,
    `checkId` VARCHAR(64) NULL,
    `body` TEXT NOT NULL,
    `followUp` VARCHAR(300) NULL,
    `prNumber` INTEGER NOT NULL,
    `baseSha` VARCHAR(64) NOT NULL,
    `headSha` VARCHAR(64) NOT NULL,
    `authorUserId` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReleaseReviewNote_scopeKey_createdAt_idx`(`scopeKey`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
