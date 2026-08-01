-- CreateTable
CREATE TABLE `QuickFilter` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `view` VARCHAR(191) NOT NULL DEFAULT 'all',
    `q` VARCHAR(191) NOT NULL DEFAULT '',
    `repo` VARCHAR(191) NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'open',
    `labels` VARCHAR(191) NOT NULL DEFAULT '',
    `assignee` VARCHAR(191) NULL,
    `sort` VARCHAR(191) NOT NULL DEFAULT 'created',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QuickFilter_userId_idx`(`userId`),
    UNIQUE INDEX `QuickFilter_userId_name_key`(`userId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `QuickFilter` ADD CONSTRAINT `QuickFilter_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
