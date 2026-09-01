-- CreateTable
-- issue-deckがmainへマージしたPRについて、本番デプロイ（deploy.yml）が実際に起動したかを
-- 見張る記録（#2703）。GitHubがマージのイベントを配送し損ねて実行が1件も作られないことが
-- あり（実測でmainへのマージ55件中1件）、マージした側だけがマージコミットのSHAを知っている。
-- プロセス内のタイマーでは持てない（PM2のmax_memory_restartによる再起動で消える）ため表にする。
CREATE TABLE `DeployLaunchWatch` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `pullRequestNumber` INTEGER NOT NULL,
    `pullRequestTitle` TEXT NOT NULL,
    `mergeCommitSha` VARCHAR(191) NOT NULL,
    `mergedAt` DATETIME(3) NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `resolvedAt` DATETIME(3) NULL,
    `runUrl` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `checkedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DeployLaunchWatch_repositoryFullName_pullRequestNumber_key`(`repositoryFullName`, `pullRequestNumber`),
    INDEX `DeployLaunchWatch_state_mergedAt_idx`(`state`, `mergedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
