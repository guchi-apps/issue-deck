-- AlterEnum
-- 手作業Issueを、サブPCのClaude Codeセッションと対話しながら実施するジョブの種別（#2771）。
-- 手作業アシスタントの代行実行（`MANUAL_STEP`）が本文のコマンドをpollerが1件ずつ実行するのに対し、
-- こちらは`<リポジトリ名>-issue-<番号>`のtmuxセッションを1本立て、手順の実行・結果の確認・失敗時の
-- 相談をセッションと直接やり取りする。枠は実装セッションと同じ（`SESSION_LAUNCH_JOB_KINDS`）。
ALTER TABLE `DispatchJob` MODIFY `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW', 'SELF_UPDATE', 'CODE_REVIEW', 'PREVIEW', 'REBOOT', 'CODEX_PAIRING', 'MANUAL_STEP_SESSION') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 手作業セッションを起こせるpollerかどうかの申告（#2771）。
-- NULL（未申告＝古いpoller）は「できない」として扱い、このジョブを配らない（未知の種別として
-- `failed`になり、押した起動が失われるため。`crossRepoQuestionCapable`と同じ向き）。
ALTER TABLE `DispatchHost` ADD COLUMN `manualStepSessionCapable` BOOLEAN NULL;
