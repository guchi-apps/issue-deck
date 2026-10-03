-- CreateTable
CREATE TABLE `DispatchSessionTimelineEvent` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `body` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DispatchSessionTimelineEvent_sessionId_occurredAt_idx`(`sessionId`, `occurredAt`),
    UNIQUE INDEX `DispatchSessionTimelineEvent_sessionId_occurredAt_kind_title_key`(`sessionId`, `occurredAt`, `kind`, `title`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DispatchSessionTimelineEvent` ADD CONSTRAINT `DispatchSessionTimelineEvent_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `DispatchSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
