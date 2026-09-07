-- AlterTable
ALTER TABLE `DispatchSession` ADD COLUMN `interruptedReason` VARCHAR(191) NULL,
    ADD COLUMN `interruptedAt` DATETIME(3) NULL;
