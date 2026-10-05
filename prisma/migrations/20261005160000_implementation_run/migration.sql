CREATE TABLE `ImplementationRun` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `runKey` VARCHAR(191) NOT NULL,
    `agent` VARCHAR(16) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `ImplementationRun_runKey_key`(`runKey`),
    INDEX `ImplementationRun_repositoryFullName_issueNumber_startedAt_idx`(`repositoryFullName`, `issueNumber`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
