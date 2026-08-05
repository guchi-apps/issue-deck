-- CreateTable
CREATE TABLE `IssueDeployCheck` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `IssueDeployCheck_issueId_idx`(`issueId`),
    UNIQUE INDEX `IssueDeployCheck_userId_issueId_key`(`userId`, `issueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `IssueDeployCheck` ADD CONSTRAINT `IssueDeployCheck_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssueDeployCheck` ADD CONSTRAINT `IssueDeployCheck_issueId_fkey` FOREIGN KEY (`issueId`) REFERENCES `Issue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
