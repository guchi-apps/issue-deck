-- AlterTable
ALTER TABLE `SessionUsage`
  ADD COLUMN `verifyCostUsd` DOUBLE NULL AFTER `codingCostUsd`;
