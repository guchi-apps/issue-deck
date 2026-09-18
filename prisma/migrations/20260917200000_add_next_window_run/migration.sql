-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `nextWindowRunEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `nextWindowRunLeadMinutes` INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN `nextWindowRunIntervalMinutes` INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE `NightlyRunEntry`
  ADD COLUMN `kind` ENUM('NIGHTLY', 'NEXT_WINDOW') NOT NULL DEFAULT 'NIGHTLY',
  ADD COLUMN `reservedResetsAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `NightlyRunEntry_status_kind_targetHost_createdAt_idx` ON `NightlyRunEntry`(`status`, `kind`, `targetHost`, `createdAt`);
