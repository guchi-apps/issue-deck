-- CreateTable
CREATE TABLE `ReleaseCandidate` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `phase` VARCHAR(32) NOT NULL,
    `frozenDevelopSha` VARCHAR(64) NOT NULL,
    `frozenPrs` JSON NOT NULL,
    `approvedExtraPrs` JSON NOT NULL,
    `currentRevision` INTEGER NOT NULL DEFAULT 0,
    `activeKey` VARCHAR(191) NULL,
    `requestKey` VARCHAR(64) NOT NULL,
    `migratedFromPrNumber` INTEGER NULL,
    `migratedFromHeadSha` VARCHAR(64) NULL,
    `createdByUserId` VARCHAR(40) NULL,
    `cancelReason` TEXT NULL,
    `cancelledByUserId` VARCHAR(40) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseCandidate_activeKey_key`(`activeKey`),
    UNIQUE INDEX `ReleaseCandidate_requestKey_key`(`requestKey`),
    INDEX `ReleaseCandidate_repositoryFullName_phase_idx`(`repositoryFullName`, `phase`),
    UNIQUE INDEX `ReleaseCandidate_repositoryFullName_sequence_key`(`repositoryFullName`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReleaseCandidateRevision` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `requestKey` VARCHAR(64) NOT NULL,
    `pendingKey` VARCHAR(40) NULL,
    `expectedHeadSha` VARCHAR(64) NULL,
    `importedPrs` JSON NOT NULL,
    `fixSeriesId` VARCHAR(40) NULL,
    `prNumber` INTEGER NULL,
    `baseSha` VARCHAR(64) NULL,
    `headSha` VARCHAR(64) NULL,
    `runUrl` VARCHAR(512) NULL,
    `failureReason` TEXT NULL,
    `requestedByUserId` VARCHAR(40) NULL,
    `appliedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleaseCandidateRevision_requestKey_key`(`requestKey`),
    UNIQUE INDEX `ReleaseCandidateRevision_pendingKey_key`(`pendingKey`),
    INDEX `ReleaseCandidateRevision_candidateId_status_idx`(`candidateId`, `status`),
    UNIQUE INDEX `ReleaseCandidateRevision_candidateId_revision_key`(`candidateId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReleaseCandidateRevision` ADD CONSTRAINT `ReleaseCandidateRevision_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `ReleaseCandidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

