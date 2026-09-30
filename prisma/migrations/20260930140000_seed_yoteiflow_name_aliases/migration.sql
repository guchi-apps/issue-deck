-- 改名 dayspan→koyomio→yoteiflow（#3654）を初期投入する。別名の記録は同期が`Repository.name`を
-- 上書きするときにしか走らず、別名機能（#3613）より前の改名は記録されていなかった。
-- 名前の状態に依らず引けるよう`githubRepositoryId`で引き、同じ行から2件作るのでidに旧名を含める。
-- 該当する行が無い環境では0件。同期がすでに記録済みの旧名は一意制約で読み飛ばす。
INSERT IGNORE INTO `RepositoryNameAlias` (`id`, `githubRepositoryId`, `oldName`, `newName`, `createdAt`, `updatedAt`)
SELECT CONCAT('alias_dayspan_', `id`), `githubRepositoryId`, 'dayspan', 'koyomio', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Repository`
WHERE `githubRepositoryId` = 1328312861;

INSERT IGNORE INTO `RepositoryNameAlias` (`id`, `githubRepositoryId`, `oldName`, `newName`, `createdAt`, `updatedAt`)
SELECT CONCAT('alias_koyomio_', `id`), `githubRepositoryId`, 'koyomio', 'yoteiflow', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Repository`
WHERE `githubRepositoryId` = 1328312861;
