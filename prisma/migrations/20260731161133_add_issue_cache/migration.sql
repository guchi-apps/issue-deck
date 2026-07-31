-- CreateTable
CREATE TABLE `Issue` (
    `id` VARCHAR(191) NOT NULL,
    `githubIssueId` INTEGER NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `title` TEXT NOT NULL,
    `body` TEXT NULL,
    `state` ENUM('OPEN', 'CLOSED') NOT NULL,
    `htmlUrl` VARCHAR(191) NOT NULL,
    `authorLogin` VARCHAR(191) NOT NULL,
    `assigneeLogin` VARCHAR(191) NULL,
    `commentCount` INTEGER NOT NULL DEFAULT 0,
    `githubCreatedAt` DATETIME(3) NOT NULL,
    `githubUpdatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Issue_githubIssueId_key`(`githubIssueId`),
    INDEX `Issue_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `Issue_repositoryId_number_key`(`repositoryId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IssueLabel` (
    `id` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `color` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `IssueLabel_issueId_name_key`(`issueId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Issue` ADD CONSTRAINT `Issue_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssueLabel` ADD CONSTRAINT `IssueLabel_issueId_fkey` FOREIGN KEY (`issueId`) REFERENCES `Issue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
