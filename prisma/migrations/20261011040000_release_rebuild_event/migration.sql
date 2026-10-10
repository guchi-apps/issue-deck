-- リリース候補の作り直しの操作履歴（#4359）。
CREATE TABLE `ReleaseRebuildEvent` (
  `id` VARCHAR(191) NOT NULL,
  `repositoryFullName` VARCHAR(191) NOT NULL,
  `originPrNumber` INTEGER NOT NULL,
  `originHeadSha` VARCHAR(64) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `actorKind` VARCHAR(16) NOT NULL,
  `actorUserId` VARCHAR(40) NULL,
  `trigger` VARCHAR(32) NOT NULL,
  `reason` TEXT NULL,
  `seriesId` VARCHAR(40) NULL,
  `payload` JSON NULL,
  `dedupeKey` VARCHAR(255) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `ReleaseRebuildEvent_dedupeKey_key`(`dedupeKey`),
  INDEX `ReleaseRebuildEvent_repositoryFullName_originPrNumber_idx`(`repositoryFullName`, `originPrNumber`),
  INDEX `ReleaseRebuildEvent_repositoryFullName_createdAt_idx`(`repositoryFullName`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
