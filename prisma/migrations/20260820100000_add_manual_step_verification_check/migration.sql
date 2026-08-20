-- CreateTable
-- openな手作業Issueの`## 完了の確認方法`を定期実行した結果（#2008）。
-- PASSEDは「完了済みの可能性」で、クローズは人が押す。
CREATE TABLE `ManualStepVerificationCheck` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `targetHost` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'PASSED', 'FAILED', 'UNAVAILABLE') NOT NULL DEFAULT 'RUNNING',
    `doneLines` TEXT NOT NULL,
    `currentJobId` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ManualStepVerificationCheck_repositoryFullName_issueNumber_key`(`repositoryFullName`, `issueNumber`),
    INDEX `ManualStepVerificationCheck_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
