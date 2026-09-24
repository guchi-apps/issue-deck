-- AlterTable
ALTER TABLE `Issue`
    ADD COLUMN `subIssuesTotal` INTEGER NULL,
    ADD COLUMN `subIssuesCompleted` INTEGER NULL,
    ADD COLUMN `parentIssueUrl` VARCHAR(191) NULL;
