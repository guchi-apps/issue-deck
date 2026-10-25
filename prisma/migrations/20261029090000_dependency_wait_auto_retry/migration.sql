-- AlterTable
ALTER TABLE `SessionDependencyWait` ADD COLUMN `resumeFailedAt` DATETIME(3) NULL,
    ADD COLUMN `autoRetryCount` INTEGER NOT NULL DEFAULT 0;
