-- CreateTable
CREATE TABLE `SharedToken` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `encryptedValue` TEXT NOT NULL,
    `description` TEXT NULL,
    `sourceReference` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SharedToken_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SharedTokenUsage` (
    `id` VARCHAR(191) NOT NULL,
    `sharedTokenId` VARCHAR(191) NOT NULL,
    `consumer` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `usedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SharedTokenUsage_sharedTokenId_usedAt_idx`(`sharedTokenId`, `usedAt`),
    INDEX `SharedTokenUsage_consumer_usedAt_idx`(`consumer`, `usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SharedTokenUsage` ADD CONSTRAINT `SharedTokenUsage_sharedTokenId_fkey` FOREIGN KEY (`sharedTokenId`) REFERENCES `SharedToken`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
