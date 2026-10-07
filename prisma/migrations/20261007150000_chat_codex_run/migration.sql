-- チャット相談のCodex CLI実行（#4109）。モデル呼び出しを`CHAT_TURN`ジョブとしてサブPCへ渡し、
-- 回答待ちの状態を`ChatRun`に持つ。
ALTER TABLE `DispatchJob` MODIFY `kind` ENUM('LAUNCH','INTERRUPT','KILL','QUESTION','INSTRUCTION','CROSS_REPO_QUESTION','MANUAL_STEP','MANUAL_STEP_ABORT','PLAN_REVIEW','SELF_UPDATE','CODE_REVIEW','PREVIEW','REBOOT','CODEX_PAIRING','MANUAL_STEP_SESSION','PR_REVIEW','REVIEW_FIX','CHAT_TURN') NOT NULL DEFAULT 'LAUNCH';
ALTER TABLE `DispatchHost` ADD COLUMN `chatCodexCapable` BOOLEAN NULL;

CREATE TABLE `ChatRun` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `userMessageId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `phase` VARCHAR(200) NOT NULL DEFAULT '',
    `provider` VARCHAR(32) NOT NULL,
    `model` VARCHAR(64) NULL,
    `failureKind` VARCHAR(32) NULL,
    `currentJobId` VARCHAR(32) NULL,
    `stepRequest` JSON NULL,
    `stepResult` TEXT NULL,
    `stepError` VARCHAR(32) NULL,
    `assistantMessageId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChatRun_userMessageId_key`(`userMessageId`),
    INDEX `ChatRun_conversationId_status_idx`(`conversationId`, `status`),
    INDEX `ChatRun_currentJobId_idx`(`currentJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ChatRun` ADD CONSTRAINT `ChatRun_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `ChatConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
