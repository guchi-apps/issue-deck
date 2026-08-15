-- AlterTable
-- ホストが申告するSWAP使用量（#1624）。nullable（既定NULL）の追加のみで、既存行の書き換えは
-- 不要。NULLは「申告していない」（SWAPを申告しない古いpoller）で、総量0（SWAPを持たない
-- ホスト）とは区別する。
ALTER TABLE `DispatchHost` ADD COLUMN `swapUsedMb` INTEGER NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `swapTotalMb` INTEGER NULL;
