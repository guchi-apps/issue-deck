-- AlterTable
-- Claude Code本体がまだ開始していないことを表す値（#1465）。初めてクローンしたリポジトリでは
-- 起動直後にフォルダの信頼確認が出て、答えるまでセッションが始まらない。フックが1つも飛ばない
-- 状態なので、pollerがホスト側の印（`.starting`）を見て立てる。
--
-- 既存の値は増やすだけで、並びも変えていないので既存行の値はそのまま残る。
ALTER TABLE `DispatchSession`
    MODIFY COLUMN `activity` ENUM('WAITING_INPUT', 'WORKING', 'RESPONDED', 'NOT_STARTED') NULL;
