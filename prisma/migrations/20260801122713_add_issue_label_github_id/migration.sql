-- AlterTable
ALTER TABLE `IssueLabel` ADD COLUMN `githubLabelId` BIGINT NULL;

-- CreateIndex
CREATE INDEX `IssueLabel_githubLabelId_idx` ON `IssueLabel`(`githubLabelId`);
