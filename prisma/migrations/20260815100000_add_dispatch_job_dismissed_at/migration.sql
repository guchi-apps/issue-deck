-- AlterTable
-- 画面から失敗の表示を消した時刻（#1479）。NULL許容の追加のみで、既存行の書き換えは不要
-- （既存行はNULL＝従来どおり表示される）。
ALTER TABLE `DispatchJob` ADD COLUMN `dismissedAt` DATETIME(3) NULL;
