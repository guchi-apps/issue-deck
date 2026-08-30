ALTER TABLE `SessionPlanRequest`
    ADD COLUMN `decisionObservedAt` DATETIME(3) NULL,
    ADD COLUMN `pollCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastPolledAt` DATETIME(3) NULL,
    ADD COLUMN `deliveryStatus` VARCHAR(32) NULL,
    ADD COLUMN `deliveryReportedAt` DATETIME(3) NULL,
    ADD COLUMN `deliveryExitCode` INTEGER NULL,
    ADD COLUMN `deliverySummary` VARCHAR(500) NULL;
