-- CreateTable
CREATE TABLE `ReleaseProductionCheck` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `mergeSha` VARCHAR(64) NOT NULL,
    `targetKind` VARCHAR(32) NOT NULL,
    `deploySucceeded` BOOLEAN NOT NULL DEFAULT false,
    `deployRunUrl` VARCHAR(512) NULL,
    `lastProbe` JSON NULL,
    `waitingReason` VARCHAR(32) NULL,
    `lastObservedAt` DATETIME(3) NULL,
    `attestedByUserId` VARCHAR(40) NULL,
    `attestationNote` TEXT NULL,
    `attestedAt` DATETIME(3) NULL,
    `method` VARCHAR(32) NULL,
    `evidence` JSON NULL,
    `verifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseProductionCheck_candidateId_key`(`candidateId`),
    INDEX `ReleaseProductionCheck_repositoryFullName_idx`(`repositoryFullName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReleaseVersionEndpoint` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `updatedByUserId` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseVersionEndpoint_repositoryFullName_key`(`repositoryFullName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReleaseProductionCheck` ADD CONSTRAINT `ReleaseProductionCheck_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `ReleaseCandidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
