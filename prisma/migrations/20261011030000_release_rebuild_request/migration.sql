-- 修正PRを選んだリリース候補の作り直し（#4335）。
ALTER TABLE `ReleasePreparationFailure` ADD COLUMN `rebuildSelection` TEXT NULL;

CREATE TABLE `ReleaseRebuildRequest` (
  `id` VARCHAR(191) NOT NULL,
  `repositoryFullName` VARCHAR(191) NOT NULL,
  `originPrNumber` INTEGER NOT NULL,
  `originHeadSha` VARCHAR(64) NOT NULL,
  `selection` JSON NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `failureReason` TEXT NULL,
  `activeKey` VARCHAR(255) NULL,
  `requestedByUserId` VARCHAR(40) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ReleaseRebuildRequest_activeKey_key`(`activeKey`),
  INDEX `ReleaseRebuildRequest_repositoryFullName_originPrNumber_idx`(`repositoryFullName`, `originPrNumber`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
