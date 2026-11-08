-- バックアップCI（CircleCI）の廃止（#5254）。関連テーブルを削除する
DROP TABLE `BackupCiSetting`;
DROP TABLE `BackupCiRun`;
DROP TABLE `CiGateState`;
DROP TABLE `CircleciWebhookDelivery`;
