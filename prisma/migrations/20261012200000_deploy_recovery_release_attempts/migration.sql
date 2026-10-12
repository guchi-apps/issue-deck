-- AlterTable
ALTER TABLE `DeployRecoverySeries`
    ADD COLUMN `releaseAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastFailureKey` VARCHAR(191) NULL;
