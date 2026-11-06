-- CreateTable
CREATE TABLE `ReleaseHistoryCache` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `entries` JSON NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReleaseHistoryCache_repositoryId_key`(`repositoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReleaseHistoryCache` ADD CONSTRAINT `ReleaseHistoryCache_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
