-- GPT-6 Sol/Lunaへ既存設定を更新する。実行済みセッションの使用量記録は変更しない。
UPDATE `AppSetting`
SET `codexModel` = CASE `codexModel`
  WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
  WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
  ELSE `codexModel`
END,
`appAiModel` = CASE `appAiModel`
  WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
  WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
  ELSE `appAiModel`
END,
`appAiModelReasoning` = CASE `appAiModelReasoning`
  WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
  WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
  ELSE `appAiModelReasoning`
END;

-- 未実行のジョブと予約は、新しいCodex CLIモデルIDで起動する。
UPDATE `DispatchJob`
SET `codexModel` = CASE `codexModel`
  WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
  WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
  ELSE `codexModel`
END
WHERE `status` = 'QUEUED';

UPDATE `ScheduledRunEntry`
SET `codexModel` = CASE `codexModel`
  WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
  WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
  ELSE `codexModel`
END
WHERE `status` = 'QUEUED';
