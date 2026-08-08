-- DropForeignKey
ALTER TABLE `IssueDeployCheck` DROP FOREIGN KEY `IssueDeployCheck_userId_fkey`;

-- DropForeignKey
ALTER TABLE `IssueDeployCheck` DROP FOREIGN KEY `IssueDeployCheck_issueId_fkey`;

-- DropTable
DROP TABLE `IssueDeployCheck`;
