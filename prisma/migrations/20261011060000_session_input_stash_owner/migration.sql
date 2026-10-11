-- 退避した未送信入力を依頼者本人だけが読める・消せるようにする（#4389）。
ALTER TABLE `SessionInputStash` ADD COLUMN `requestedByUserId` VARCHAR(191) NULL;
CREATE INDEX `SessionInputStash_requestedByUserId_idx` ON `SessionInputStash`(`requestedByUserId`);
