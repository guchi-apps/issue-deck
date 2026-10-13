-- CreateTable
CREATE TABLE `ReleaseStartLock` (
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `acquiredAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`repositoryFullName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
