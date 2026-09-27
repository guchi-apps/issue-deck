-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `defaultDispatchAgent` VARCHAR(191) NOT NULL DEFAULT 'claude',
  ADD COLUMN `dispatchFailoverEnabled` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `dispatchFailoverThresholdPercent` INTEGER NOT NULL DEFAULT 90;
