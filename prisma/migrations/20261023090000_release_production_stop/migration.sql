-- AlterTable
ALTER TABLE `ReleaseCandidate` ADD COLUMN `productionStopReason` VARCHAR(40) NULL,
    ADD COLUMN `productionStopDetail` TEXT NULL,
    ADD COLUMN `productionCheckStartedAt` DATETIME(3) NULL,
    ADD COLUMN `successorProofKey` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `ReleaseCandidate_successorProofKey_key` ON `ReleaseCandidate`(`successorProofKey`);
