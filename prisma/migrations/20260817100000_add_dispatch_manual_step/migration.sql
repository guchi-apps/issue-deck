-- AlterTable
-- 手作業アシスタントからの代行実行（#1828）。ENUMへの値の追加のみで、既存行の書き換えは不要。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 代行実行するコマンドと結果（#1828）。すべてnullableの追加で、`MANUAL_STEP`のジョブにだけ入る。
--
-- `command`に入るのは**サーバーが手作業Issueの本文から抽出し直したものだけ**で、画面から届いた
-- 文字列は照合にしか使わない。`commandOutput`はシークレットが混ざりうるため、画面（ログイン必須）
-- 以外へは出さない。
ALTER TABLE `DispatchJob` ADD COLUMN `command` TEXT NULL;
ALTER TABLE `DispatchJob` ADD COLUMN `manualStepLine` INTEGER NULL;
ALTER TABLE `DispatchJob` ADD COLUMN `exitCode` INTEGER NULL;
ALTER TABLE `DispatchJob` ADD COLUMN `commandOutput` TEXT NULL;

-- AlterTable
-- 代行実行を実行できるpollerだけが申告する（#1828）。既存行はNULL（未申告＝できない）のまま。
ALTER TABLE `DispatchHost` ADD COLUMN `manualStepCapable` BOOLEAN NULL;
