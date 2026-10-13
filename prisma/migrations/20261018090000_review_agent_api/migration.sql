-- AlterTable
ALTER TABLE `ReleaseFixInternalRound` ADD COLUMN `reviewerKind` VARCHAR(16) NULL,
    ADD COLUMN `reviewerRef` VARCHAR(120) NULL;

-- CreateTable
CREATE TABLE `ReviewAgentToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `tokenPrefix` VARCHAR(16) NOT NULL,
    `scopes` VARCHAR(64) NOT NULL,
    `repositories` JSON NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReviewAgentToken_tokenHash_key`(`tokenHash`),
    INDEX `ReviewAgentToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReviewAgentAuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `tokenId` VARCHAR(40) NULL,
    `userId` VARCHAR(40) NULL,
    `tool` VARCHAR(64) NOT NULL,
    `repositoryFullName` VARCHAR(191) NULL,
    `issueNumber` INTEGER NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `errorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReviewAgentAuditLog_tokenId_createdAt_idx`(`tokenId`, `createdAt`),
    INDEX `ReviewAgentAuditLog_repositoryFullName_createdAt_idx`(`repositoryFullName`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReviewAgentIdempotency` (
    `id` VARCHAR(191) NOT NULL,
    `tokenId` VARCHAR(40) NOT NULL,
    `idemKey` VARCHAR(120) NOT NULL,
    `tool` VARCHAR(64) NOT NULL,
    `requestHash` VARCHAR(64) NOT NULL,
    `response` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReviewAgentIdempotency_tokenId_idemKey_key`(`tokenId`, `idemKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
