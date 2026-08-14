-- AlterTable
-- セッション自身がフック（#1219）から報告してくる直近の様子と、Remote ControlのURL（#1264）。
-- 既存行はNULLのまま（次のフック発火で埋まる）。
ALTER TABLE `DispatchSession`
    ADD COLUMN `activity` ENUM('WAITING_INPUT', 'RESPONDED') NULL,
    ADD COLUMN `activityAt` DATETIME(3) NULL,
    ADD COLUMN `remoteControlUrl` TEXT NULL;
