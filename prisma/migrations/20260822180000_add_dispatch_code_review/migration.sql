-- AlterTable
-- リポジトリ全体のコードレビューのセッションを起こすジョブ（#698）。ENUMへの値の追加のみで、
-- 既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW', 'SELF_UPDATE', 'CODE_REVIEW') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- コードレビューのセッションを起こせるpollerだけが申告する（#698）。既存行はNULL（未申告＝できない）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `codeReviewCapable` BOOLEAN NULL;
