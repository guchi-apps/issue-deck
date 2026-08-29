-- CreateTable
-- 添付画像がどこに貼られているかの索引（#2475）。
-- **Repository・Issueへの外部キーを張らない。** 連携が外れてIssue行がカスケードで消えても、
-- 参照まで道連れにして「一斉に未使用」へ変わることが無いようにするため。
CREATE TABLE `UploadedImageReference` (
    `id` VARCHAR(191) NOT NULL,
    `filename` VARCHAR(191) NOT NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `isPullRequest` BOOLEAN NOT NULL DEFAULT false,
    `foundAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UploadedImageReference_filename_sourceKey_key`(`filename`, `sourceKey`),
    INDEX `UploadedImageReference_filename_idx`(`filename`),
    INDEX `UploadedImageReference_sourceKey_idx`(`sourceKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- このリポジトリのIssueコメントをどこまで読んだか（#2475）。値は読み終えた最後のコメントの
-- `updated_at`。NULLは「一度も読んでいない」で、1つでも残っていれば自動削除を始めない。
ALTER TABLE `Repository` ADD COLUMN `imageCommentScanAt` DATETIME(3) NULL;

-- AlterTable
-- 参照されていない添付画像の自動削除（#2475）。
-- `imageScanCompletedAt`に既定値を置かない——置くと、マイグレーション直後に
-- 「全件確認済み・参照0件」という最悪の状態が成立する。
ALTER TABLE `AppSetting`
  ADD COLUMN `imageCleanupEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `imageRetentionDays` INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN `imageScanCompletedAt` DATETIME(3) NULL;
