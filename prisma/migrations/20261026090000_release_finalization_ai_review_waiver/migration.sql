-- 全体レビューの結果を承知で公開準備へ進んだかを記録する（#4807）。既存の行はfalse（従来どおり全体レビューも必須）
ALTER TABLE `ReleaseCandidateFinalization` ADD COLUMN `aiReviewWaived` BOOLEAN NOT NULL DEFAULT false;
