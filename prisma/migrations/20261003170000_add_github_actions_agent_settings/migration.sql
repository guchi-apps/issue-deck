ALTER TABLE `AppSetting`
  ADD COLUMN `githubActionsAgent` VARCHAR(191) NOT NULL DEFAULT 'claude',
  ADD COLUMN `githubActionsCodexModel` VARCHAR(191) NOT NULL DEFAULT 'gpt-5.6-terra';
