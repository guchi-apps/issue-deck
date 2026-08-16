-- AlterTable
-- セッションを自動で畳む予定（#1817）。nullable（既定NULL）の追加のみで、既存行の書き換えは
-- 不要。NULLは「畳む予定が無い」（作業中・入力待ち・条件を満たしていない・古いpoller）で、
-- サブPCの`scripts/reap-sessions.sh`が猶予待ちと判定したセッションにだけ値が入る。
--
-- `reapReason`は文言ではなく理由コード（`ISSUE_CLOSED`・`PR_MERGED`・`HANDOFF_PR_OPEN`・
-- `HANDOFF_NO_PR`・`QUESTION_CLOSED`・`QUESTION_IDLE`）。ENUMにしないのは、経路が増えるたびに
-- マイグレーションが要るのと、知らない値を受け取っても画面側で落とせば済むため。
ALTER TABLE `DispatchSession` ADD COLUMN `reapAt` DATETIME(3) NULL;
ALTER TABLE `DispatchSession` ADD COLUMN `reapReason` VARCHAR(191) NULL;
