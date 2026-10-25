-- CreateTable
CREATE TABLE `AppAiCodexRun` (
    `id` VARCHAR(191) NOT NULL,
    `feature` VARCHAR(48) NOT NULL,
    `model` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `currentJobId` VARCHAR(32) NULL,
    `stepRequest` JSON NULL,
    `stepResult` TEXT NULL,
    `stepError` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AppAiCodexRun_currentJobId_idx`(`currentJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
