-- AlterTable
-- 順番待ちの中で先に払い出す度合い（#1541）。既定0の追加のみで、既存行の書き換えは不要
-- （すべて0になり、同じ値なら`createdAt`の昇順＝従来どおり積んだ順に流れる）。
ALTER TABLE `DispatchJob` ADD COLUMN `queuePriority` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
-- 払い出し（claimDispatchJob）が引く条件（targetHost・status・kind）に、並び替えの
-- キーを足したもの。
CREATE INDEX `DispatchJob_targetHost_status_kind_queuePriority_idx` ON `DispatchJob`(`targetHost`, `status`, `kind`, `queuePriority`);
