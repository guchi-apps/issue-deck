-- CreateTable
CREATE TABLE `BackupCiSetting` (
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `circleciProjectSlug` VARCHAR(191) NULL,
    `circleciDefinitionId` VARCHAR(191) NULL,
    `updatedByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`repositoryFullName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BackupCiRun` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `prNumber` INTEGER NOT NULL,
    `headRef` VARCHAR(191) NOT NULL,
    `baseRef` VARCHAR(191) NOT NULL,
    `headSha` VARCHAR(191) NOT NULL,
    `baseSha` VARCHAR(191) NOT NULL,
    `attempt` INTEGER NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'circleci',
    `status` VARCHAR(191) NOT NULL,
    `activeKey` VARCHAR(191) NULL,
    `startedByUserId` VARCHAR(191) NOT NULL,
    `definitionDigest` VARCHAR(191) NULL,
    `resultDigest` VARCHAR(191) NULL,
    `testedSha` VARCHAR(191) NULL,
    `testedParents` VARCHAR(191) NULL,
    `externalPipelineId` VARCHAR(191) NULL,
    `externalPipelineNumber` INTEGER NULL,
    `externalWorkflowId` VARCHAR(191) NULL,
    `externalJobNumber` INTEGER NULL,
    `logUrl` TEXT NULL,
    `checksJson` TEXT NULL,
    `statusReason` TEXT NULL,
    `gateState` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `triggeredAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `lastReconciledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BackupCiRun_activeKey_key`(`activeKey`),
    UNIQUE INDEX `BackupCiRun_externalPipelineId_key`(`externalPipelineId`),
    INDEX `BackupCiRun_status_idx`(`status`),
    UNIQUE INDEX `BackupCiRun_repositoryFullName_prNumber_attempt_key`(`repositoryFullName`, `prNumber`, `attempt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CircleciWebhookDelivery` (
    `eventId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CircleciWebhookDelivery_receivedAt_idx`(`receivedAt`),
    PRIMARY KEY (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
