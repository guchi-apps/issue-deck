-- AlterTable
-- 計画の関門（G1・#1218）のセッションを起こすジョブ（#1855）。ENUMへの値の追加のみで、
-- 既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'PLAN_REVIEW') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 計画レビューのセッションを起こせるpollerだけが申告する（#1855）。既存行はNULL（未申告＝できない）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `planReviewCapable` BOOLEAN NULL;
