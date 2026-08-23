-- CreateTable
-- ローカルセッションが`AskUserQuestion`で聞いた質問への、画面からの回答待ち（#2189）。
-- 計画の承認待ち（`SessionPlanRequest`・#2061）の質問版で、待っている中身が
-- 「選択肢つきの質問の配列」である点だけが違う。
CREATE TABLE `SessionQuestionRequest` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `hostName` VARCHAR(191) NULL,
    `questions` TEXT NOT NULL,
    `status` ENUM('WAITING', 'ANSWERED', 'DEFERRED', 'EXPIRED') NOT NULL DEFAULT 'WAITING',
    `answers` TEXT NULL,
    `decidedByUserId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SessionQuestionRequest_repositoryFullName_issueNumber_idx`(`repositoryFullName`, `issueNumber`),
    INDEX `SessionQuestionRequest_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
