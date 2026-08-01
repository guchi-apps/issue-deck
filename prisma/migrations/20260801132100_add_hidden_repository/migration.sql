-- CreateTable
CREATE TABLE `HiddenRepository` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HiddenRepository_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `HiddenRepository_userId_repositoryId_key`(`userId`, `repositoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HiddenRepository` ADD CONSTRAINT `HiddenRepository_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HiddenRepository` ADD CONSTRAINT `HiddenRepository_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
