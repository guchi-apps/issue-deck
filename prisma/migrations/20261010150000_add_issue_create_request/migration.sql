-- Issue作成の冪等キー（#3847）。再送で同じIssueを二重に作らない。
CREATE TABLE `IssueCreateRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `resultJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `IssueCreateRequest_userId_key_key`(`userId`, `key`),
    INDEX `IssueCreateRequest_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
