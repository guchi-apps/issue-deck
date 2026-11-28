-- AlterTable
ALTER TABLE `ReleaseCandidate`
  ADD COLUMN `autoPublishUserId` VARCHAR(40) NULL,
  ADD COLUMN `autoPublishStartedAt` DATETIME(3) NULL,
  ADD COLUMN `autoPublishStopCode` VARCHAR(40) NULL,
  ADD COLUMN `autoPublishStoppedAt` DATETIME(3) NULL,
  ADD COLUMN `autoPublishStopReason` TEXT NULL;

-- AlterTable: 公開承認の自動化の設定（#5629）は全自動の開始に置き換えて廃止する
ALTER TABLE `AppSetting`
  DROP COLUMN `releaseAutoApprovalEnabled`;
