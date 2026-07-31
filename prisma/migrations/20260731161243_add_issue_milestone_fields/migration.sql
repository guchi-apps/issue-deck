-- AlterTable
ALTER TABLE `Issue` ADD COLUMN `milestoneClosed` INTEGER NULL,
    ADD COLUMN `milestoneOpen` INTEGER NULL,
    ADD COLUMN `milestoneTitle` VARCHAR(191) NULL;
