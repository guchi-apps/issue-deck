-- AlterTable
-- 質問ジョブの種別（#1294）。ENUMへの値の追加のみで、既存行の書き換えは不要
-- （既存行はすべてLAUNCH・INTERRUPT・KILLのいずれかで、既定値もLAUNCHのまま）。
-- **この時点では積む経路も払い出し口も無い**（器だけを先に入れる。実行はStep 3）。
ALTER TABLE `DispatchJob`
    MODIFY COLUMN `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION') NOT NULL DEFAULT 'LAUNCH';
