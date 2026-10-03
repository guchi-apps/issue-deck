-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `planReviewAgentForClaude` VARCHAR(191) NOT NULL DEFAULT 'claude',
  ADD COLUMN `planReviewAgentForCodex` VARCHAR(191) NOT NULL DEFAULT 'codex';
