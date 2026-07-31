-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `supabaseUserId` VARCHAR(191) NOT NULL,
    `githubUserId` INTEGER NOT NULL,
    `githubLogin` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `image` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_supabaseUserId_key`(`supabaseUserId`),
    UNIQUE INDEX `User_githubUserId_key`(`githubUserId`),
    UNIQUE INDEX `User_githubLogin_key`(`githubLogin`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GithubInstallation` (
    `id` VARCHAR(191) NOT NULL,
    `installationId` INTEGER NOT NULL,
    `accountId` INTEGER NOT NULL,
    `accountLogin` VARCHAR(191) NOT NULL,
    `accountType` ENUM('USER', 'ORGANIZATION') NOT NULL,
    `repositorySelection` ENUM('ALL', 'SELECTED') NOT NULL,
    `suspendedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GithubInstallation_installationId_key`(`installationId`),
    INDEX `GithubInstallation_accountLogin_idx`(`accountLogin`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserInstallation` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `installationId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `UserInstallation_userId_installationId_key`(`userId`, `installationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Repository` (
    `id` VARCHAR(191) NOT NULL,
    `githubRepositoryId` INTEGER NOT NULL,
    `installationId` VARCHAR(191) NOT NULL,
    `ownerLogin` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `private` BOOLEAN NOT NULL,
    `htmlUrl` VARCHAR(191) NOT NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `defaultBranch` VARCHAR(191) NOT NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Repository_githubRepositoryId_key`(`githubRepositoryId`),
    INDEX `Repository_installationId_idx`(`installationId`),
    UNIQUE INDEX `Repository_installationId_fullName_key`(`installationId`, `fullName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `UserInstallation` ADD CONSTRAINT `UserInstallation_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserInstallation` ADD CONSTRAINT `UserInstallation_installationId_fkey` FOREIGN KEY (`installationId`) REFERENCES `GithubInstallation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Repository` ADD CONSTRAINT `Repository_installationId_fkey` FOREIGN KEY (`installationId`) REFERENCES `GithubInstallation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
