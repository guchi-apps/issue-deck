-- AlterTable
-- 走っているセッションへの追加指示（#1012）。ENUMへの値の追加のみで、既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 追加指示の本文。`kind`が`INSTRUCTION`のときだけ入る。既存行はNULLのまま。
ALTER TABLE `DispatchJob` ADD COLUMN `instruction` TEXT NULL;

-- AlterTable
-- 3段階プロトコルに対応したpollerだけが申告する（#1012）。既存行はNULL（未申告＝できない）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `instructionCapable` BOOLEAN NULL;
