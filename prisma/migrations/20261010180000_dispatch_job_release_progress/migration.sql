-- リリースの統合検証・全体レビューの現在の工程をジョブに残す（#4277）。
ALTER TABLE `DispatchJob` ADD COLUMN `progress` JSON NULL;
