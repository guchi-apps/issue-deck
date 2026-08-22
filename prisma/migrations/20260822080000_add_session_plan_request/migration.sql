-- CreateTable
-- ローカルセッションが`ExitPlanMode`で出した計画に対する、画面からの返事（#2061）。
-- `send-keys`は使わず、計画を投稿したフックがここの`status`が決まるのを待って
-- Claude Code自身の許可判定として返す。
CREATE TABLE `SessionPlanRequest` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `hostName` VARCHAR(191) NULL,
    `plan` TEXT NOT NULL,
    `status` ENUM('WAITING', 'APPROVED', 'REVISION_REQUESTED', 'DEFERRED', 'EXPIRED') NOT NULL DEFAULT 'WAITING',
    `revisionText` TEXT NULL,
    `decidedByUserId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SessionPlanRequest_repositoryFullName_issueNumber_idx`(`repositoryFullName`, `issueNumber`),
    INDEX `SessionPlanRequest_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
