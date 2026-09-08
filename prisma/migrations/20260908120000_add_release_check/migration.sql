-- リリース後の動作確認フラグ（#2930）

-- ユーザーごとに「動作確認を追う」と選んだリポジトリ。
-- `createdAt`は「いつからのリリースを対象にするか」の基準時刻でもある。
CREATE TABLE `ReleaseCheckTarget` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReleaseCheckTarget_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `ReleaseCheckTarget_userId_repositoryId_key`(`userId`, `repositoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ユーザーごとに「このリリースの動作確認は済んだ」と記録した1件。
-- GitHub ReleaseはDBに持たないため、リポジトリ＋タグ名の組で指す。
CREATE TABLE `ReleaseCheck` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `tagName` VARCHAR(191) NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReleaseCheck_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `ReleaseCheck_userId_repositoryId_tagName_key`(`userId`, `repositoryId`, `tagName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ReleaseCheckTarget` ADD CONSTRAINT `ReleaseCheckTarget_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ReleaseCheckTarget` ADD CONSTRAINT `ReleaseCheckTarget_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ReleaseCheck` ADD CONSTRAINT `ReleaseCheck_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ReleaseCheck` ADD CONSTRAINT `ReleaseCheck_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
