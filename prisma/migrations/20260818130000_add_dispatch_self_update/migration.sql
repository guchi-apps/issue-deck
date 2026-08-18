-- AlterTable
-- サブPCのチェックアウトを更新してpollerを再起動するジョブ（#1875）。ENUMへの値の追加のみで、
-- 既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'PLAN_REVIEW', 'SELF_UPDATE') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- チェックアウトを更新して自分を畳めるpollerだけが申告する（#1875）。既存行はNULL（未申告＝できない）のまま。
-- manualStepCapableと分けて持つ理由はschema.prismaのコメント参照。
ALTER TABLE `DispatchHost` ADD COLUMN `selfUpdateCapable` BOOLEAN NULL;
