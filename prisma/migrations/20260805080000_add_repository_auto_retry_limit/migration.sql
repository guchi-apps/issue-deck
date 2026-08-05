-- AlterTable
ALTER TABLE `Repository`
    ADD COLUMN `autoRetryLimit` INTEGER NOT NULL DEFAULT 0;
