-- AlterTable
-- Codexのセッションで、`codex queue`の宛先（スレッドUUID）が分かっているか（#2519）。
-- NULLは「Codexのセッションではない（Claude Code）」または「申告しない古いpoller」。
-- FALSEは「Codexだが、ディレクトリの信頼確認に答えていないため宛先が取れていない」で、
-- そのあいだ画面は追加指示のボタンを無効にして理由を出す。
ALTER TABLE `DispatchSession` ADD COLUMN `codexThreadKnown` BOOLEAN NULL;
