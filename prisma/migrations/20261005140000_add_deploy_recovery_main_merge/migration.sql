-- AlterTable
ALTER TABLE `DeployRecoverySeries`
    ADD COLUMN `fixMergeCommitSha` VARCHAR(191) NULL,
    ADD COLUMN `recoveryPullRequestNumber` INTEGER NULL,
    ADD COLUMN `recoveryHeadRef` VARCHAR(191) NULL,
    ADD COLUMN `recoveryHeadSha` VARCHAR(191) NULL,
    ADD COLUMN `recoveryBaseSha` VARCHAR(191) NULL,
    ADD COLUMN `recoveryFiles` TEXT NULL,
    ADD COLUMN `recoveryMergedSha` VARCHAR(191) NULL;
