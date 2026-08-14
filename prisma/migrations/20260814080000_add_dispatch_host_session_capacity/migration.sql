-- AlterTable
-- セッション本数の上限（#1361）と申告時点の本数（#1394）。既存行はNULL（未申告）のまま。
-- 判定はpoller側に残したままで、ここに持つのは画面へ出すための写し。
ALTER TABLE `DispatchHost` ADD COLUMN `maxSessions` INTEGER NULL;
ALTER TABLE `DispatchHost` ADD COLUMN `liveSessions` INTEGER NULL;
