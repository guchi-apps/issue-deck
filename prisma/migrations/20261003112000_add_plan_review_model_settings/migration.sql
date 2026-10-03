-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `planReviewClaudeModel` VARCHAR(191) NOT NULL DEFAULT 'sonnet',
  ADD COLUMN `planReviewCodexModel` VARCHAR(191) NOT NULL DEFAULT 'gpt-5.6-terra';
