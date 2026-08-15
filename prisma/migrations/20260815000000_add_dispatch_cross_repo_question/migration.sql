-- AlterTable
-- 複数リポジトリ横断の質問セッション（#1454）。ENUMへの値の追加のみで、既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 横断質問セッションを起こせるpollerだけが申告する（#1454）。既存行はNULL（未申告＝できない）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `crossRepoQuestionCapable` BOOLEAN NULL;
