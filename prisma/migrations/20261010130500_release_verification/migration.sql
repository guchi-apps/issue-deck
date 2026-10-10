-- CreateTable
CREATE TABLE `ReleaseVerification` (
    `id` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `prNumber` INTEGER NOT NULL,
    `baseSha` VARCHAR(64) NOT NULL,
    `headSha` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `state` VARCHAR(32) NOT NULL,
    `agent` VARCHAR(64) NULL,
    `summary` TEXT NULL,
    `findings` JSON NULL,
    `unverifiedScope` TEXT NULL,
    `evidenceUrl` VARCHAR(500) NULL,
    `message` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReleaseVerification_repoFullName_prNumber_idx`(`repoFullName`, `prNumber`),
    UNIQUE INDEX `ReleaseVerification_target_key`(`repoFullName`, `prNumber`, `baseSha`, `headSha`, `kind`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
