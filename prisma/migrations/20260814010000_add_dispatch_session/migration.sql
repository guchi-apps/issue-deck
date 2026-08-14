-- CreateTable
CREATE TABLE `DispatchSession` (
    `id` VARCHAR(191) NOT NULL,
    `host` VARCHAR(191) NOT NULL,
    `tmuxSessionName` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `state` ENUM('ALIVE', 'EXITED', 'FAILED', 'GONE') NOT NULL,
    `exitStatus` INTEGER NULL,
    `firstSeenAt` DATETIME(3) NOT NULL,
    `lastReportedAt` DATETIME(3) NOT NULL,
    `escalatedState` ENUM('ALIVE', 'EXITED', 'FAILED', 'GONE') NULL,
    `escalatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DispatchSession_host_tmuxSessionName_key`(`host`, `tmuxSessionName`),
    INDEX `DispatchSession_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
