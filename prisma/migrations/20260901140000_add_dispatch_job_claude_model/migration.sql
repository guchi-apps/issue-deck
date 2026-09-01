-- AlterTable
-- Issueごとに使うClaudeのモデルを起動時に選べるようにする（#2717）。
-- NULLは「設定の既定（AppSetting.claudeLocalModel）に従う」で、既存行はすべてNULLになる。
ALTER TABLE `DispatchJob` ADD COLUMN `claudeModel` VARCHAR(191) NULL;
