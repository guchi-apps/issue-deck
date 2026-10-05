-- AlterTable（既存会話・発言・確認状態はそのまま残り、新しい列は既定値で埋まる）
ALTER TABLE `ChatConversation`
    ADD COLUMN `memory` JSON NULL,
    ADD COLUMN `refsText` TEXT NULL,
    ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `archivedAt` DATETIME(3) NULL;

UPDATE `ChatConversation` SET `memory` = JSON_OBJECT(), `refsText` = '';

ALTER TABLE `ChatConversation`
    MODIFY `memory` JSON NOT NULL,
    MODIFY `refsText` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `ChatMessage` ADD COLUMN `clientMessageId` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `ChatMessage_conversationId_clientMessageId_key` ON `ChatMessage`(`conversationId`, `clientMessageId`);

-- DropIndex / CreateIndex
CREATE INDEX `ChatConversation_userId_archivedAt_updatedAt_idx` ON `ChatConversation`(`userId`, `archivedAt`, `updatedAt`);
DROP INDEX `ChatConversation_userId_updatedAt_idx` ON `ChatConversation`;
