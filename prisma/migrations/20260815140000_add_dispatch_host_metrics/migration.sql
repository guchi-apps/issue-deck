-- AlterTable
-- ホストが申告するリソース使用率（#1567）。すべてnullable（既定NULL）の追加のみで、
-- 既存行の書き換えは不要。NULLは「申告していない」で、0（空いている）とは区別する。
ALTER TABLE `DispatchHost` ADD COLUMN `cpuPercent` DOUBLE NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `memoryUsedMb` INTEGER NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `memoryTotalMb` INTEGER NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `diskUsedGb` DOUBLE NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `diskTotalGb` DOUBLE NULL;
