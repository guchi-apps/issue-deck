-- 別のAIへ引き継いで起動するジョブの指定（#3496）。
-- handoffFromのNULLは通常の起動で、既存行はすべてNULLになる。handoffTranscriptの既定は要約のみ（false）。
ALTER TABLE `DispatchJob` ADD COLUMN `handoffFrom` VARCHAR(191) NULL;
ALTER TABLE `DispatchJob` ADD COLUMN `handoffTranscript` BOOLEAN NOT NULL DEFAULT false;
