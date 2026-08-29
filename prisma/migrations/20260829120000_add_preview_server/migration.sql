-- AlterEnum
-- 確認環境（#2444）の起動・更新・停止を運ぶジョブの種別。
ALTER TABLE `DispatchJob` MODIFY `kind` ENUM('LAUNCH', 'INTERRUPT', 'KILL', 'QUESTION', 'INSTRUCTION', 'CROSS_REPO_QUESTION', 'MANUAL_STEP', 'MANUAL_STEP_ABORT', 'PLAN_REVIEW', 'SELF_UPDATE', 'CODE_REVIEW', 'PREVIEW') NOT NULL DEFAULT 'LAUNCH';

-- AlterTable
-- 確認環境への操作（`start` / `refresh` / `stop`）。pollerへ渡すのはこの3語と
-- リポジトリ名だけで、コマンドもポートも渡さない。
ALTER TABLE `DispatchJob` ADD COLUMN `previewAction` VARCHAR(191) NULL;

-- AlterTable
-- 確認環境を起こせるpollerかどうかの申告（#2444）。
-- NULL（未申告＝古いpoller）は「できない」として扱い、確認環境のジョブを払い出さない。
ALTER TABLE `DispatchHost` ADD COLUMN `previewCapable` BOOLEAN NULL;

-- AlterTable
-- 確認環境を起こせるリポジトリ（#2444）。`repositories`の部分集合で、開発サーバーを持たない
-- リポジトリ（package.json が無いもの）を画面の一覧から除くために持つ。
ALTER TABLE `DispatchHost` ADD COLUMN `previewRepositories` TEXT NULL;

-- AlterTable
-- いま動いている確認環境の写し（#2444）。同時に1つだけなのでホストの列で持つ。
ALTER TABLE `DispatchHost`
  ADD COLUMN `previewRepository` VARCHAR(191) NULL,
  ADD COLUMN `previewBranch` VARCHAR(191) NULL,
  ADD COLUMN `previewPort` INTEGER NULL,
  ADD COLUMN `previewUrl` VARCHAR(191) NULL,
  ADD COLUMN `previewCommit` VARCHAR(191) NULL,
  ADD COLUMN `previewSubject` TEXT NULL,
  ADD COLUMN `previewStartedAt` DATETIME(3) NULL,
  ADD COLUMN `previewIdleMinutes` INTEGER NULL;
