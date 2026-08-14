-- AlterTable
-- ホストがスクリーンショットを撮れるか（#1268）。既存行はNULL（未申告）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `screenshotCapable` BOOLEAN NULL;
