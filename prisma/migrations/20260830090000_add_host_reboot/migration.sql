-- AlterEnum
-- ホストごと再起動するジョブの種別（#2496）。SELF_UPDATE（pollerのプロセスだけを畳む）とは別物で、
-- こちらはOSごと落ちるため、走っているセッションは戻らない。
ALTER TABLE `DispatchJob` MODIFY `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW', 'SELF_UPDATE', 'CODE_REVIEW', 'PREVIEW', 'REBOOT') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- パスワード無しで再起動できるpollerかどうかの申告（#2496）。
-- NULL（未申告＝古いpoller、またはsudoの許可が入っていないホスト）は「できない」として扱い、
-- 再起動のジョブを払い出さず、画面のボタンも押させない。
ALTER TABLE `DispatchHost` ADD COLUMN `rebootCapable` BOOLEAN NULL;

-- AlterTable
-- 再起動が要るか（#2496）。`/var/run/reboot-required`の有無とmtime、ホストの起動時刻。
-- 画面へ出すための写しで、押せるかどうかの判定には使わない（判定に使うのはセッション本数だけ）。
ALTER TABLE `DispatchHost`
  ADD COLUMN `rebootRequired` BOOLEAN NULL,
  ADD COLUMN `rebootRequiredSince` DATETIME(3) NULL,
  ADD COLUMN `bootedAt` DATETIME(3) NULL;
