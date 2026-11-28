-- 最新世代のモデルへ、既定値と保存済みの設定を移す（#5668）。実行済みの使用量・ジョブの記録は書き換えない。
ALTER TABLE `AppSetting`
  ALTER COLUMN `githubActionsCodexModel` SET DEFAULT 'gpt-6.1-terra',
  ALTER COLUMN `codexModel` SET DEFAULT 'gpt-6.1-terra',
  ALTER COLUMN `planReviewCodexModel` SET DEFAULT 'gpt-6.1-terra';

UPDATE `AppSetting`
SET
  `codexModel` = CASE `codexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `codexModel`
  END,
  `githubActionsCodexModel` = CASE `githubActionsCodexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `githubActionsCodexModel`
  END,
  `workflowCodexModel` = CASE `workflowCodexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `workflowCodexModel`
  END,
  `planReviewCodexModel` = CASE `planReviewCodexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `planReviewCodexModel`
  END,
  `appAiModel` = CASE `appAiModel`
    WHEN 'claude-haiku-4-5' THEN 'claude-haiku-5-5'
    WHEN 'claude-fable-5-1' THEN 'claude-fable-5-2'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    ELSE `appAiModel`
  END,
  `appAiModelReasoning` = CASE `appAiModelReasoning`
    WHEN 'claude-haiku-4-5' THEN 'claude-haiku-5-5'
    WHEN 'claude-fable-5-1' THEN 'claude-fable-5-2'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    ELSE `appAiModelReasoning`
  END,
  `nextWindowRunBulkModel` = CASE `nextWindowRunBulkModel`
    WHEN 'codex:gpt-6-astra' THEN 'codex:gpt-6.2-astra'
    WHEN 'codex:gpt-6-sol' THEN 'codex:gpt-6.2-sol'
    WHEN 'codex:gpt-5.6-terra' THEN 'codex:gpt-6.1-terra'
    WHEN 'codex:gpt-5.5' THEN 'codex:gpt-6.1-terra'
    WHEN 'codex:gpt-5.4' THEN 'codex:gpt-6.1-terra'
    ELSE `nextWindowRunBulkModel`
  END;

-- 未実行のジョブ・予約と、進行中の親Issueの自動実行は、新しいモデルIDで起動する。
UPDATE `DispatchJob`
SET
  `codexModel` = CASE `codexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `codexModel`
  END
WHERE `status` = 'QUEUED';

UPDATE `NightlyRunEntry`
SET
  `codexModel` = CASE `codexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `codexModel`
  END
WHERE `status` = 'QUEUED';

UPDATE `ParentRun`
SET
  `codexModel` = CASE `codexModel`
    WHEN 'gpt-6-astra' THEN 'gpt-6.2-astra'
    WHEN 'gpt-6-sol' THEN 'gpt-6.2-sol'
    WHEN 'gpt-5.6-terra' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.5' THEN 'gpt-6.1-terra'
    WHEN 'gpt-5.4' THEN 'gpt-6.1-terra'
    ELSE `codexModel`
  END
WHERE `status` IN ('RUNNING', 'PAUSED');
