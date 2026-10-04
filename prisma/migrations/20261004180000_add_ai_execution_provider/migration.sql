-- グローバル既定値を追加し、従来の既定値だけを継承指定へ移行する。
-- 明示的に異なるCLI／モデルを選んでいた設定はそのまま個別Overrideとして残す。
ALTER TABLE `AppSetting`
  ADD COLUMN `aiExecutionProvider` VARCHAR(191) NOT NULL DEFAULT 'claude',
  ALTER COLUMN `githubActionsAgent` SET DEFAULT 'inherit',
  ALTER COLUMN `defaultDispatchAgent` SET DEFAULT 'inherit',
  ALTER COLUMN `planReviewAgentForClaude` SET DEFAULT 'inherit',
  ALTER COLUMN `planReviewAgentForCodex` SET DEFAULT 'inherit',
  ALTER COLUMN `appAiModel` SET DEFAULT 'inherit',
  ALTER COLUMN `appAiModelReasoning` SET DEFAULT 'inherit';

UPDATE `AppSetting`
SET
  `githubActionsAgent` = IF(`githubActionsAgent` = 'claude', 'inherit', `githubActionsAgent`),
  `defaultDispatchAgent` = IF(`defaultDispatchAgent` = 'claude', 'inherit', `defaultDispatchAgent`),
  `planReviewAgentForClaude` = IF(`planReviewAgentForClaude` = 'claude', 'inherit', `planReviewAgentForClaude`),
  `planReviewAgentForCodex` = IF(`planReviewAgentForCodex` = 'codex', 'inherit', `planReviewAgentForCodex`),
  `appAiModel` = IF(`appAiModel` = 'claude-haiku-4-5', 'inherit', `appAiModel`),
  `appAiModelReasoning` = IF(`appAiModelReasoning` IN ('claude-sonnet-5', 'claude-sonnet-5-5'), 'inherit', `appAiModelReasoning`);
