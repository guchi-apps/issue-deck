-- CreateTable
-- ユーザーごとに「いまは実施しない」として伏せた要対応の項目（#2398）。
-- 対象にはマージ待ちのPull Requestも含まれ、そちらはDBに行を持たないため、
-- Issueへの外部キーではなく repositoryId + kind + number で両方を指す。
-- until が NULL なら「手動で解除するまで」。過ぎた行は消さず、有効かどうかは
-- src/lib/snooze.ts の純粋関数が現在時刻を見て判定する。
CREATE TABLE `SnoozedItem` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `repositoryId` VARCHAR(191) NOT NULL,
    `kind` ENUM('ISSUE', 'PULL_REQUEST') NOT NULL,
    `number` INTEGER NOT NULL,
    `until` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SnoozedItem_repositoryId_idx`(`repositoryId`),
    UNIQUE INDEX `SnoozedItem_userId_repositoryId_kind_number_key`(`userId`, `repositoryId`, `kind`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SnoozedItem` ADD CONSTRAINT `SnoozedItem_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SnoozedItem` ADD CONSTRAINT `SnoozedItem_repositoryId_fkey` FOREIGN KEY (`repositoryId`) REFERENCES `Repository`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
