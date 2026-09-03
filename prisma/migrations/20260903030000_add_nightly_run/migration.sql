-- AlterTable
-- 夜間実行（#2772）の設定。既定はOFF（無人で実装が進む処理は人が納得してから有効にする）。
-- 開始時刻は日本時間の「時」（22〜5）。判定は`src/lib/nightly-run.ts`が持つ。
ALTER TABLE `AppSetting` ADD COLUMN `nightlyRunEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `nightlyRunStartHour` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
-- 「今夜の夜間実行」に積んだIssue（#2772）。時刻が来たら`enqueueDispatchJob`を通して
-- `DispatchJob`へ変換し、`dispatchJobId`で結ぶ。`activeKey`はQUEUEDの間だけ入るunique列で、
-- 同じIssueの二重投入を防ぐ（`DispatchJob.activeKey`と同じ形）。
CREATE TABLE `NightlyRunEntry` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `targetHost` VARCHAR(191) NOT NULL,
    `agent` VARCHAR(191) NOT NULL DEFAULT 'claude',
    `claudeModel` VARCHAR(191) NULL,
    `optionLabels` JSON NOT NULL,
    `status` ENUM('QUEUED', 'LAUNCHED', 'SKIPPED', 'CANCELED') NOT NULL DEFAULT 'QUEUED',
    `activeKey` VARCHAR(191) NULL,
    `nightKey` VARCHAR(191) NULL,
    `skipReason` TEXT NULL,
    `dispatchJobId` VARCHAR(191) NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,

    UNIQUE INDEX `NightlyRunEntry_activeKey_key`(`activeKey`),
    INDEX `NightlyRunEntry_status_targetHost_createdAt_idx`(`status`, `targetHost`, `createdAt`),
    INDEX `NightlyRunEntry_nightKey_idx`(`nightKey`),
    INDEX `NightlyRunEntry_repositoryFullName_issueNumber_idx`(`repositoryFullName`, `issueNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
