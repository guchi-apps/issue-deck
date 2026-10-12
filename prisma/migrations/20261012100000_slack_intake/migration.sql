-- CreateTable
CREATE TABLE `SlackIntakeRequest` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(32) NOT NULL,
    `channelId` VARCHAR(32) NOT NULL,
    `parentTs` VARCHAR(32) NOT NULL,
    `slackUserId` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `permalink` TEXT NULL,
    `text` TEXT NOT NULL,
    `selectedRepo` VARCHAR(200) NULL,
    `status` VARCHAR(24) NOT NULL,
    `failure` TEXT NULL,
    `conversationId` VARCHAR(191) NULL,
    `proposal` JSON NULL,
    `confirmState` VARCHAR(16) NULL,
    `issues` JSON NOT NULL,
    `selectorTs` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SlackIntakeRequest_teamId_channelId_parentTs_key`(`teamId`, `channelId`, `parentTs`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SlackProcessedEvent` (
    `eventKey` VARCHAR(160) NOT NULL,
    `messageTs` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`eventKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
