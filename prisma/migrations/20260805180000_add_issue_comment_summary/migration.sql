-- CreateTable
CREATE TABLE `IssueCommentSummary` (
    `id` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `githubCommentId` BIGINT NOT NULL,
    `summary` TEXT NOT NULL,
    `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `IssueCommentSummary_issueId_idx`(`issueId`),
    UNIQUE INDEX `IssueCommentSummary_issueId_githubCommentId_key`(`issueId`, `githubCommentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `IssueCommentSummary` ADD CONSTRAINT `IssueCommentSummary_issueId_fkey` FOREIGN KEY (`issueId`) REFERENCES `Issue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
