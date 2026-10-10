-- リリース準備の失敗記録（#4335）。
CREATE TABLE `ReleasePreparationFailure` (
  `id` VARCHAR(191) NOT NULL,
  `repositoryFullName` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(32) NOT NULL,
  `runUrl` VARCHAR(512) NOT NULL,
  `event` VARCHAR(32) NULL,
  `bumpKind` VARCHAR(16) NULL,
  `jobName` VARCHAR(255) NULL,
  `stepName` VARCHAR(255) NULL,
  `errorExcerpt` TEXT NULL,
  `status` VARCHAR(16) NOT NULL,
  `resolvedAt` DATETIME(3) NULL,
  `resolvedRunUrl` VARCHAR(512) NULL,
  `clearedIssues` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ReleasePreparationFailure_repositoryFullName_runId_key`(`repositoryFullName`, `runId`),
  INDEX `ReleasePreparationFailure_repositoryFullName_status_idx`(`repositoryFullName`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
