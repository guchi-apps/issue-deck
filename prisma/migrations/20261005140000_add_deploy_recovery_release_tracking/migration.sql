-- AlterTable
ALTER TABLE `DeployRecoverySeries`
    ADD COLUMN `releaseSha` VARCHAR(191) NULL,
    ADD COLUMN `releaseStartedAt` DATETIME(3) NULL,
    ADD COLUMN `releaseRunId` BIGINT NULL,
    ADD COLUMN `releaseRunUrl` TEXT NULL,
    ADD COLUMN `recoveredAt` DATETIME(3) NULL;
