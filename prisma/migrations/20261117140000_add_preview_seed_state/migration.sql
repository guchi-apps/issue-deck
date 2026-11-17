-- AlterTable
ALTER TABLE `DispatchHost`
  ADD COLUMN `previewSeedStatus` VARCHAR(191) NULL,
  ADD COLUMN `previewSeedNote` TEXT NULL;
