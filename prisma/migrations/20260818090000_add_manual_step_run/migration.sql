-- AlterTable
-- 走っている代行実行を止めるジョブ（#1882）。ENUMへの値の追加のみで、既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 止める対象のジョブid（#1882）。`MANUAL_STEP_ABORT`のジョブにだけ入る。
-- pollerはこのidから`issue-deck-manual-step-<id>`というユニット名を組み立て直して止める。
ALTER TABLE `DispatchJob` ADD COLUMN `targetJobId` VARCHAR(191) NULL;

-- AlterTable
-- 走っている代行実行を止められるpollerだけが申告する（#1882）。既存行はNULL（未申告＝できない）。
ALTER TABLE `DispatchHost` ADD COLUMN `manualStepAbortCapable` BOOLEAN NULL;

-- CreateTable
-- 手作業アシスタントの自動実行1本（#1882）。#1869では画面だけが持っていた状態で、
-- 画面を閉じても進み・進行状況を確認できるようにするためサーバーへ移した。
CREATE TABLE `ManualStepRun` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `targetHost` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'PAUSED', 'FINISHED', 'STOPPED') NOT NULL DEFAULT 'RUNNING',
    `pausedReason` ENUM('USER', 'FAILED', 'ENQUEUE_FAILED') NULL,
    `doneLines` TEXT NOT NULL,
    `diagnoseConsent` BOOLEAN NOT NULL DEFAULT true,
    `startedByUserId` VARCHAR(191) NULL,
    `currentJobId` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ManualStepRun_repositoryFullName_issueNumber_key`(`repositoryFullName`, `issueNumber`),
    INDEX `ManualStepRun_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
