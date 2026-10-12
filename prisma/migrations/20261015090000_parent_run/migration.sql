-- CreateTable
CREATE TABLE `ParentRun` (
    `id` VARCHAR(191) NOT NULL,
    `parentRepository` VARCHAR(191) NOT NULL,
    `parentIssue` INTEGER NOT NULL,
    `planVersion` INTEGER NOT NULL,
    `hostName` VARCHAR(191) NOT NULL,
    `agent` VARCHAR(16) NOT NULL DEFAULT 'claude',
    `claudeModel` VARCHAR(32) NULL,
    `codexModel` VARCHAR(32) NULL,
    `maxParallel` INTEGER NOT NULL DEFAULT 2,
    `status` VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
    `startedByUserId` VARCHAR(191) NOT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `activeKey` VARCHAR(255) NULL,
    `lastSweepAt` DATETIME(3) NULL,
    `notice` VARCHAR(500) NULL,
    `summary` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ParentRun_activeKey_key`(`activeKey`),
    INDEX `ParentRun_parentRepository_parentIssue_idx`(`parentRepository`, `parentIssue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParentRunChild` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `repository` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `launchState` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `jobId` VARCHAR(191) NULL,
    `launchedAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `display` JSON NULL,
    `lastError` VARCHAR(500) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ParentRunChild_runId_repository_number_key`(`runId`, `repository`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ParentRunChild` ADD CONSTRAINT `ParentRunChild_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ParentRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
