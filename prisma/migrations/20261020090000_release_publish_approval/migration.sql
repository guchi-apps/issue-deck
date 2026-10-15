-- AlterTable
ALTER TABLE `ReleaseCompletionRun` ADD COLUMN `publishApprovalId` VARCHAR(40) NULL;

-- CreateTable
CREATE TABLE `ReleasePublishApproval` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `prNumber` INTEGER NOT NULL,
    `baseSha` VARCHAR(64) NOT NULL,
    `headSha` VARCHAR(64) NOT NULL,
    `bumpPolicy` VARCHAR(8) NOT NULL,
    `allowedChanges` JSON NOT NULL,
    `contents` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `activeKey` VARCHAR(40) NULL,
    `requestKey` VARCHAR(64) NOT NULL,
    `approvedByUserId` VARCHAR(40) NOT NULL,
    `approvedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `completionRunId` VARCHAR(40) NULL,
    `invalidReason` VARCHAR(64) NULL,
    `invalidDetail` TEXT NULL,
    `invalidDiff` JSON NULL,
    `invalidatedAt` DATETIME(3) NULL,
    `revokedByUserId` VARCHAR(40) NULL,
    `revokedAt` DATETIME(3) NULL,
    `mergeSha` VARCHAR(64) NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReleasePublishApproval_activeKey_key`(`activeKey`),
    UNIQUE INDEX `ReleasePublishApproval_requestKey_key`(`requestKey`),
    INDEX `ReleasePublishApproval_candidateId_status_idx`(`candidateId`, `status`),
    INDEX `ReleasePublishApproval_repositoryFullName_idx`(`repositoryFullName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReleasePublishApproval` ADD CONSTRAINT `ReleasePublishApproval_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `ReleaseCandidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
