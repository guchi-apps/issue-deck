-- AlterTable
ALTER TABLE `ReleaseFixSeries`
    ADD COLUMN `internalReview` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `internalStopReason` TEXT NULL;

-- CreateTable
CREATE TABLE `ReleaseFixInternalRound` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `round` INTEGER NOT NULL,
    `reviewVerdict` VARCHAR(16) NULL,
    `reviewTargetSha` VARCHAR(64) NULL,
    `reviewSummary` TEXT NULL,
    `reviewedAt` DATETIME(3) NULL,
    `testState` VARCHAR(16) NULL,
    `testTargetSha` VARCHAR(64) NULL,
    `testSummary` TEXT NULL,
    `testedAt` DATETIME(3) NULL,
    `openFindingCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReleaseFixInternalRound_repositoryFullName_issueNumber_round_key`(`repositoryFullName`, `issueNumber`, `round`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReleaseFixFinding` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `key` VARCHAR(16) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `detail` TEXT NULL,
    `status` VARCHAR(16) NOT NULL,
    `resolution` TEXT NULL,
    `firstRound` INTEGER NOT NULL,
    `lastRound` INTEGER NOT NULL,
    `reopenCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseFixFinding_repositoryFullName_issueNumber_key_key`(`repositoryFullName`, `issueNumber`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
