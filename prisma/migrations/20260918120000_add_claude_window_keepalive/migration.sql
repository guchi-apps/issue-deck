-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `claudeWindowKeepAliveEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `claudeWindowKeepAliveStartHour` INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN `claudeWindowKeepAliveEndHour` INTEGER NOT NULL DEFAULT 23,
  ADD COLUMN `claudeWindowKeepAliveProbedAt` DATETIME(3) NULL;
