-- CreateTable
CREATE TABLE `ReleaseCandidateFinalization` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `prNumber` INTEGER NOT NULL,
    `preBaseSha` VARCHAR(64) NOT NULL,
    `preHeadSha` VARCHAR(64) NOT NULL,
    `reservedVersion` VARCHAR(32) NULL,
    `bumpKind` VARCHAR(8) NULL,
    `bumpKindSource` VARCHAR(8) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `requestKey` VARCHAR(64) NOT NULL,
    `pendingKey` VARCHAR(40) NULL,
    `finalBaseSha` VARCHAR(64) NULL,
    `finalHeadSha` VARCHAR(64) NULL,
    `diffFiles` JSON NOT NULL,
    `handoffEvidence` JSON NOT NULL,
    `runUrl` VARCHAR(512) NULL,
    `failureReason` TEXT NULL,
    `requestedByUserId` VARCHAR(40) NULL,
    `appliedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseCandidateFinalization_requestKey_key`(`requestKey`),
    UNIQUE INDEX `ReleaseCandidateFinalization_pendingKey_key`(`pendingKey`),
    INDEX `ReleaseCandidateFinalization_candidateId_status_idx`(`candidateId`, `status`),
    INDEX `ReleaseCandidateFinalization_repositoryFullName_prNumber_idx`(`repositoryFullName`, `prNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReleaseVersionReservation` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `version` VARCHAR(32) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `consumedMergeSha` VARCHAR(64) NULL,
    `consumedTag` VARCHAR(64) NULL,
    `consumedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReleaseVersionReservation_candidateId_status_idx`(`candidateId`, `status`),
    UNIQUE INDEX `ReleaseVersionReservation_repositoryFullName_version_key`(`repositoryFullName`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReleaseCandidateFinalization` ADD CONSTRAINT `ReleaseCandidateFinalization_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `ReleaseCandidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReleaseVersionReservation` ADD CONSTRAINT `ReleaseVersionReservation_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `ReleaseCandidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
