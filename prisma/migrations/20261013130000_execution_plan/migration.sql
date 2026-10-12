-- CreateTable
CREATE TABLE `ExecutionPlan` (
    `id` VARCHAR(191) NOT NULL,
    `parentRepository` VARCHAR(191) NOT NULL,
    `parentIssue` INTEGER NOT NULL,
    `currentVersion` INTEGER NOT NULL,
    `boundVersion` INTEGER NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExecutionPlan_parentRepository_parentIssue_key`(`parentRepository`, `parentIssue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExecutionPlanVersion` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `changeNote` VARCHAR(300) NOT NULL,
    `author` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ExecutionPlanVersion_planId_version_key`(`planId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ExecutionPlanVersion` ADD CONSTRAINT `ExecutionPlanVersion_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `ExecutionPlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
