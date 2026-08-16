-- AlterTable
-- pollerが動かしているチェックアウトの鮮度（#1612）。nullable（既定NULL）の追加のみで、
-- 既存行の書き換えは不要。NULLは「申告していない」（古いpoller・gitが無い・読めなかった巡）で、
-- 「遅れ0」とは区別する。
ALTER TABLE `DispatchHost` ADD COLUMN `checkoutCommit` VARCHAR(191) NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `checkoutBranch` VARCHAR(191) NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `checkoutCommittedAt` DATETIME(3) NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `checkoutBehind` INTEGER NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `checkoutFetchedAt` DATETIME(3) NULL;
