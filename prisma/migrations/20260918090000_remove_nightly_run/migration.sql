-- 夜間実行の機能削除（#3019）。既存の「今夜の夜間実行」に積んだままの予定（kind=NIGHTLYかつ
-- QUEUED）は、起動処理を止めた後は二度と処理されず、画面からも取り消せなくなるため、
-- 先に取り消し済み（CANCELED）へ倒しておく。
UPDATE `NightlyRunEntry`
SET `status` = 'CANCELED',
    `activeKey` = NULL,
    `nightKey` = NULL,
    `skipReason` = '夜間実行の機能削除（#3019）により取り消しました',
    `resolvedAt` = NOW(3)
WHERE `kind` = 'NIGHTLY' AND `status` = 'QUEUED';

-- AlterTable
ALTER TABLE `AppSetting` DROP COLUMN `nightlyRunEnabled`,
    DROP COLUMN `nightlyRunStartHour`;

-- AlterTable
ALTER TABLE `NightlyRunEntry` MODIFY `kind` ENUM('NIGHTLY', 'NEXT_WINDOW') NOT NULL DEFAULT 'NEXT_WINDOW';
