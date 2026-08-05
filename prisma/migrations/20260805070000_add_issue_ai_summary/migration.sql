-- AlterTable
ALTER TABLE `Issue`
    ADD COLUMN `aiSummary` TEXT NULL,
    ADD COLUMN `aiSummaryCommentCount` INTEGER NULL,
    ADD COLUMN `aiSummaryGeneratedAt` DATETIME(3) NULL;
