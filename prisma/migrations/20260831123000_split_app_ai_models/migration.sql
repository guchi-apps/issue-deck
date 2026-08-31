-- 判断を伴うアプリ内AI処理を、要約・検索などの定型処理から分ける。
ALTER TABLE `AppSetting`
ADD COLUMN `appAiModelReasoning` VARCHAR(191) NOT NULL DEFAULT 'claude-sonnet-5';

ALTER TABLE `AppSetting`
ADD COLUMN `claudeLocalModel` VARCHAR(191) NOT NULL DEFAULT 'sonnet';

-- Codexの通常実装は速度優先のLunaではなく、品質とのバランスが取れたTerraを既定にする。
ALTER TABLE `AppSetting`
MODIFY `codexModel` VARCHAR(191) NOT NULL DEFAULT 'gpt-5.6-terra';

UPDATE `AppSetting`
SET `codexModel` = 'gpt-5.6-terra'
WHERE `codexModel` = 'gpt-5.6-luna';
