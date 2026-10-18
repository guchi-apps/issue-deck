-- Issueに紐づかないリモートセッションを立てる（#4743）。
ALTER TABLE `DispatchJob` MODIFY `kind` ENUM('LAUNCH','INTERRUPT','KILL','QUESTION','INSTRUCTION','CROSS_REPO_QUESTION','MANUAL_STEP','MANUAL_STEP_ABORT','PLAN_REVIEW','SELF_UPDATE','CODE_REVIEW','PREVIEW','REBOOT','CODEX_PAIRING','MANUAL_STEP_SESSION','PR_REVIEW','REVIEW_FIX','CHAT_TURN','RELEASE_VERIFY','RELEASE_REVIEW','REMOTE_SESSION','REMOTE_SESSION_KILL') NOT NULL DEFAULT 'LAUNCH';

ALTER TABLE `DispatchHost` ADD COLUMN `remoteSessionCapable` BOOLEAN NULL;

CREATE TABLE `RemoteSession` (
    `id` VARCHAR(191) NOT NULL,
    `repositoryFullName` VARCHAR(191) NOT NULL,
    `host` VARCHAR(191) NOT NULL,
    `tmuxSessionName` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `remoteControlUrl` VARCHAR(255) NULL,
    `launchJobId` VARCHAR(191) NULL,
    `failureMessage` TEXT NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RemoteSession_tmuxSessionName_key`(`tmuxSessionName`),
    UNIQUE INDEX `RemoteSession_launchJobId_key`(`launchJobId`),
    INDEX `RemoteSession_repositoryFullName_status_idx`(`repositoryFullName`, `status`),
    INDEX `RemoteSession_host_status_idx`(`host`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
