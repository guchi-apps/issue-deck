-- リリース本文の箇条書き1行（1機能）ごとの確認チェック（#2982）

-- ユーザーごとに「この箇条書き行は確認した」と記録した1件。
-- GitHub ReleaseはDBに持たないため、リポジトリ＋タグ名＋行インデックスの組で指す。
CREATE TABLE `ReleaseCheckLine` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `tagName` VARCHAR(191) NOT NULL,
    `lineIndex` INTEGER NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReleaseCheckLine_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `ReleaseCheckLine_userId_repositoryId_tagName_lineIndex_key`(`userId`, `repositoryId`, `tagName`, `lineIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ReleaseCheckLine` ADD CONSTRAINT `ReleaseCheckLine_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ReleaseCheckLine` ADD CONSTRAINT `ReleaseCheckLine_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
