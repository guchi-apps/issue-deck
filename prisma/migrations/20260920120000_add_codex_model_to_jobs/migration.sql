-- このIssueだけに使うCodexのモデル（#3192）。
-- NULLは「設定の既定（AppSetting.codexModel）に従う」で、既存行はすべてNULLになる。
ALTER TABLE `DispatchJob` ADD COLUMN `codexModel` VARCHAR(191) NULL;
ALTER TABLE `NightlyRunEntry` ADD COLUMN `codexModel` VARCHAR(191) NULL;
