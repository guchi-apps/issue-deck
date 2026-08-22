-- CreateTable
-- ブラウザのPush購読1件（#838）。端末×ブラウザごとに1行で、ユーザーごとではない。
-- endpointはPushサービスが払い出す宛先URLそのもの。TEXTには一意インデックスを張れないため、
-- 同一判定はSHA-256（endpointKey）で行う。
CREATE TABLE `PushSubscription` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `endpoint` TEXT NOT NULL,
    `endpointKey` VARCHAR(191) NOT NULL,
    `p256dh` TEXT NOT NULL,
    `auth` TEXT NOT NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PushSubscription_endpointKey_key`(`endpointKey`),
    INDEX `PushSubscription_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PushSubscription` ADD CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- 確認待ちのPush通知を送った目印（#838）。00.check-userが付き直すたびにNULLへ戻す。
ALTER TABLE `Issue` ADD COLUMN `checkUserPushSentAt` DATETIME(3) NULL;
