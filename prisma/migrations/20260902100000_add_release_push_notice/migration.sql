-- CreateTable
-- リリース（本番反映）の完了をPush通知した記録（#2725）。
-- リポジトリごとに1行だけ持ち、「どのリリースまで鳴らしたか」を覚える。
-- 記録の無いリポジトリは鳴らさずに現在のタグだけ入れる（導入直後の一斉通知を避ける種まき）。
CREATE TABLE `ReleasePushNotice` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `tagName` VARCHAR(191) NOT NULL,
    `publishedAt` DATETIME(3) NULL,
    `notifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleasePushNotice_repositoryFullName_key`(`repositoryFullName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
