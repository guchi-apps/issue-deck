-- AlterTable
ALTER TABLE `SessionUsage`
  ADD COLUMN `researchCostUsd` DOUBLE NULL,
  ADD COLUMN `codingCostUsd` DOUBLE NULL,
  ADD COLUMN `wrapupCostUsd` DOUBLE NULL;
