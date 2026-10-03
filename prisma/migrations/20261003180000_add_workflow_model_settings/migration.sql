ALTER TABLE `AppSetting`
  ADD COLUMN `workflowClaudeModel` VARCHAR(191) NOT NULL DEFAULT 'auto',
  ADD COLUMN `workflowCodexModel` VARCHAR(191) NOT NULL DEFAULT 'auto',
  ADD COLUMN `workflowCodexReasoningEffort` VARCHAR(191) NOT NULL DEFAULT 'default';
