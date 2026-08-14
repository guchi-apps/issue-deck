-- AlterTable
-- 起動を見送ったジョブの状態（#1229）。既にそのIssueのtmuxセッションが動いていたために
-- pollerが起動しなかった場合で、失敗でも成功でもない第3の結果として区別する。
-- 既存行はいずれの値も取らないため、データの移行は不要。
ALTER TABLE `DispatchJob`
    MODIFY `status` ENUM('QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMEOUT', 'CANCELED') NOT NULL DEFAULT 'QUEUED';
