-- AlterTable
-- 同期・スキップした項目の**名前だけ**を残す（#2022）。
-- 画面に「何の値が同期されたのか」を出すためで、値そのものも値の長さも保存しない。
-- 既存の行と、項目名を報告しない古いタグの共有ワークフローからの報告では空文字になる。
ALTER TABLE `SecretSyncRun`
    ADD COLUMN `syncedKeys` TEXT NOT NULL,
    ADD COLUMN `skippedKeys` TEXT NOT NULL;
