-- CreateTable
-- 本番へのマージ待ち（develop→mainのリリースPR）をPush通知した記録（#2376）。
-- 持つのは「いつ鳴らしたか」だけで、マージ待ちかどうかの正はGitHubのPR。
-- プロセス内に持つと、PM2のmax_memory_restartによる再起動のたびに鳴り直すため表にする。
CREATE TABLE `ReleaseMergePushNotice` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `pullRequestNumber` INTEGER NOT NULL,
    `notifiedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseMergePushNotice_repositoryFullName_pullRequestNumber_key`(`repositoryFullName`, `pullRequestNumber`),
    INDEX `ReleaseMergePushNotice_repositoryFullName_idx`(`repositoryFullName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
