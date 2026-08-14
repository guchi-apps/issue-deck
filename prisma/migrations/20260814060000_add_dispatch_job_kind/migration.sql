-- AlterTable
-- ジョブの種別（#1332）。既存行はすべて起動ジョブなのでLAUNCHが既定で、データの移行は不要。
ALTER TABLE `DispatchJob`
    ADD COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL') NOT NULL DEFAULT 'LAUNCH';

-- CreateIndex
-- claimは「そのホストのQUEUEDのうち制御ジョブを先に」引く（#1332）。
CREATE INDEX `DispatchJob_targetHost_status_kind_idx` ON `DispatchJob`(`targetHost`, `status`, `kind`);

-- AlterTable
-- 走っているセッションを画面から操作できるか（#1332）。既存行はNULL（未申告＝非対応扱い）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `sessionControlCapable` BOOLEAN NULL;
