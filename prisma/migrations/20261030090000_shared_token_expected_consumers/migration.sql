-- AlterTable
ALTER TABLE `SharedToken` ADD COLUMN `expectedConsumers` JSON NULL;

-- CreateTable
CREATE TABLE `SharedTokenConsumerAlert` (
    `id` VARCHAR(191) NOT NULL,
    `sharedTokenId` VARCHAR(191) NOT NULL,
    `consumer` VARCHAR(100) NOT NULL,
    `lastNotifiedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SharedTokenConsumerAlert_sharedTokenId_consumer_key`(`sharedTokenId`, `consumer`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SharedTokenConsumerAlert` ADD CONSTRAINT `SharedTokenConsumerAlert_sharedTokenId_fkey` FOREIGN KEY (`sharedTokenId`) REFERENCES `SharedToken`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
