-- CreateTable
CREATE TABLE `ReleaseRebuildHistoryCutoff` (
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `completedThroughPrNumber` INTEGER NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`repositoryFullName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
