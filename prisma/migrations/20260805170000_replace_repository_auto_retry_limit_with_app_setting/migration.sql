-- AlterTable
ALTER TABLE `Repository` DROP COLUMN `autoRetryLimit`;

-- CreateTable
CREATE TABLE `AppSetting` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `autoRetryLimit` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- InsertSingletonRow
INSERT INTO `AppSetting` (`id`, `autoRetryLimit`, `updatedAt`) VALUES (1, 0, CURRENT_TIMESTAMP(3));
