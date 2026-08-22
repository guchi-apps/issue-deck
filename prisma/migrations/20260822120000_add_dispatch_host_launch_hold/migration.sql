-- AlterTable
-- メモリ・SWAPが逼迫している間、pollerが新しいセッションの起動を見送っていることを画面へ出す（#2095）。
-- 3列はまとめて入るかまとめてNULLで、既存行はNULL（＝見送っていない・申告しない古いpoller）のまま。
ALTER TABLE `DispatchHost`
    ADD COLUMN `launchHoldReason` VARCHAR(191) NULL,
    ADD COLUMN `launchHoldPercent` DOUBLE NULL,
    ADD COLUMN `launchHoldThresholdPercent` DOUBLE NULL;
