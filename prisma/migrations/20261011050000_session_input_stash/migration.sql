-- 未送信入力を確認付きで退避してから追加指示を送る（#4383）。
ALTER TABLE `DispatchJob` ADD COLUMN `stashInput` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `SessionInputStash` (
  `id` VARCHAR(191) NOT NULL,
  `jobId` VARCHAR(191) NOT NULL,
  `repositoryFullName` VARCHAR(191) NOT NULL,
  `issueNumber` INTEGER NOT NULL,
  `host` VARCHAR(191) NOT NULL,
  `tmuxSessionName` VARCHAR(191) NOT NULL,
  `content` MEDIUMTEXT NOT NULL,
  `charCount` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `SessionInputStash_jobId_key`(`jobId`),
  INDEX `SessionInputStash_repositoryFullName_issueNumber_idx`(`repositoryFullName`, `issueNumber`),
  INDEX `SessionInputStash_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
