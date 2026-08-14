-- AlterTable
-- tailscale serveでtailnetへ出した開発サーバーのURL（#1265）。既存行はNULLのまま。
ALTER TABLE `DispatchSession` ADD COLUMN `previewUrl` TEXT NULL;
