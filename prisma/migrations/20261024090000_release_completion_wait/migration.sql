-- AlterTable
ALTER TABLE `ReleaseCompletionRun` ADD COLUMN `waitReason` TEXT NULL,
    ADD COLUMN `waitSince` DATETIME(3) NULL;
