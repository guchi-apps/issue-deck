-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `releaseAutoApprovalEnabled` BOOLEAN NOT NULL DEFAULT false;
