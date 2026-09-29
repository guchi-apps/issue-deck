-- CreateTable
CREATE TABLE `RepositoryNameAlias` (
    `id` VARCHAR(191) NOT NULL,
    `githubRepositoryId` INTEGER NOT NULL,
    `oldName` VARCHAR(191) NOT NULL,
    `newName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RepositoryNameAlias_oldName_key`(`oldName`),
    INDEX `RepositoryNameAlias_githubRepositoryId_idx`(`githubRepositoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 既知の改名 myroom→kurashio（#3603）を初期投入する。本番が改名後の同期の前後どちらでも
-- 1件入るよう、旧名・新名の両方の`fullName`で引く。該当する行が無い環境では0件。
INSERT INTO `RepositoryNameAlias` (`id`, `githubRepositoryId`, `oldName`, `newName`, `createdAt`, `updatedAt`)
SELECT CONCAT('alias_', `id`), `githubRepositoryId`, 'myroom', 'kurashio', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Repository`
WHERE `fullName` IN ('guchi-apps/kurashio', 'guchi-apps/myroom');
