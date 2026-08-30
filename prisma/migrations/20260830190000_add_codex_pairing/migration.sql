-- AlterEnum
-- Codexのペアリングコードを発行するジョブの種別（#2524）。Claude CodeのRemote Control（#1219）が
-- URLを出すのに対し、Codexが出すのは10分で切れる`XXXX-XXXX`のペアリングコードなので、
-- `scripts/session-notify.sh`のURL拾いを流用できず、押したときに発行して画面へ返す形にする。
ALTER TABLE `DispatchJob` MODIFY `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW', 'SELF_UPDATE', 'CODE_REVIEW', 'PREVIEW', 'REBOOT', 'CODEX_PAIRING') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 発行したペアリングコードと、その期限（#2524）。**これは資格情報**なので、ログイン必須の画面に
-- だけ出し、期限を過ぎたら`expireStaleDispatchJobs`が列ごと空にする（`placeholderValues`と同じ扱い）。
ALTER TABLE `DispatchJob`
  ADD COLUMN `codexPairingCode` VARCHAR(64) NULL,
  ADD COLUMN `codexPairingExpiresAt` DATETIME(3) NULL;

-- AlterTable
-- Codexのペアリングコードを発行できるpollerかどうかの申告（#2524）。
-- NULL（未申告＝古いpoller、またはnpmで入れたCodex）は「できない」として扱う。
-- `remote-control`が動くのはstandalone installで入れたCodexだけ（#2521）。
ALTER TABLE `DispatchHost` ADD COLUMN `codexRemoteControlCapable` BOOLEAN NULL;
