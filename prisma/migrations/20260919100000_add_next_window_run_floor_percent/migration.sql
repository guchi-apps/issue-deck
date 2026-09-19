-- AlterTable
ALTER TABLE `AppSetting`
  ADD COLUMN `nextWindowRunFiveHourFloorPercent` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `nextWindowRunWeeklyFloorPercent` INTEGER NOT NULL DEFAULT 0;
