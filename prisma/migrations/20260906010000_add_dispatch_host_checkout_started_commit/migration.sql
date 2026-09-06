-- AlterTable
-- pollerが起動した時点でチェックアウトが指していたコミット（#2815）。nullable（既定NULL）の
-- 追加のみで、既存行の書き換えは不要。NULLは「申告していない」（#2815より前のpoller・gitが
-- 読めなかった巡）で、「checkoutCommitと一致している」とは区別する。
ALTER TABLE `DispatchHost` ADD COLUMN `checkoutStartedCommit` VARCHAR(191) NULL;
