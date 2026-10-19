-- AlterTable
ALTER TABLE `DispatchJob` ADD COLUMN `modelPickSource` VARCHAR(191) NULL,
    ADD COLUMN `modelPickModel` VARCHAR(191) NULL,
    ADD COLUMN `modelPickProbabilities` JSON NULL;

-- AlterTable
ALTER TABLE `NightlyRunEntry` ADD COLUMN `modelPickSource` VARCHAR(191) NULL,
    ADD COLUMN `modelPickModel` VARCHAR(191) NULL,
    ADD COLUMN `modelPickProbabilities` JSON NULL;
