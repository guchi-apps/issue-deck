-- AlterTable
-- 起こすエージェントCLI（#2505）。`ISSUE_DECK_AGENT`へそのまま渡せる小文字の語が入る。
-- 既定は`claude`で、**既存行はすべてこの値になる**（画面から選ばずに積まれた行の挙動は変わらない）。
ALTER TABLE `DispatchJob` ADD COLUMN `agent` VARCHAR(191) NOT NULL DEFAULT 'claude';

-- AlterTable
-- Codex CLIでローカルセッションを起こせるpollerかどうかの申告（#2505）。
-- NULL（未申告＝古いpoller）は「できない」として扱う。古いpollerは`agent`を読まないため、
-- 配るとCodexを選んだのにClaude Codeが黙って立つ。
ALTER TABLE `DispatchHost` ADD COLUMN `codexCapable` BOOLEAN NULL;
