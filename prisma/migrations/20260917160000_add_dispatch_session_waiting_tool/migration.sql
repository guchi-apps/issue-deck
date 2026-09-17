-- 実装セッションが許可を待っているツールと対象（#2971）
ALTER TABLE `DispatchSession` ADD COLUMN `waitingTool` VARCHAR(100) NULL,
    ADD COLUMN `waitingTarget` TEXT NULL;
