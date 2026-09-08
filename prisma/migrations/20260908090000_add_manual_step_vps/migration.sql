-- VPSの手順の代行実行（#2901）
-- サブPCからVPSへSSHで到達できるpollerだけが申告する（NULL = 未申告 = できない）
ALTER TABLE `DispatchHost` ADD COLUMN `manualStepVpsCapable` BOOLEAN NULL;
-- 代行実行をどこで走らせるか（`subpc` / `vps`。NULL = この列より前のジョブ = サブPC）
ALTER TABLE `DispatchJob` ADD COLUMN `manualStepRunTarget` VARCHAR(191) NULL;
