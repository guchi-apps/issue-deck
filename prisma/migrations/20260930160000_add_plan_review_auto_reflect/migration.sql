-- AlterTable
ALTER TABLE `AppSetting` ADD COLUMN `planReviewAutoReflectEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `planReviewAutoReflectMaxRounds` INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE `DispatchJob` ADD COLUMN `planReviewDecidedAt` DATETIME(3) NULL;
