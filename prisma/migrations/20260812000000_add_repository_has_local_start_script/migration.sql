-- AlterTable
ALTER TABLE `Repository`
    ADD COLUMN `hasLocalStartScript` BOOLEAN NOT NULL DEFAULT false;
