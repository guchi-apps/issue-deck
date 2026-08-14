-- AlterTable
-- 承認プロンプトに人が答えて作業へ戻ったことを表す値（#1357）。
-- `RESPONDED`（応答の終了）とは別に持つ。同じ値で表すと、答えた直後の作業中に
-- 「応答を終えています／次の指示を待っている場合があります」と出てしまう。
--
-- 既存の値は増やすだけで、並びも`WAITING_INPUT`・`RESPONDED`の順を変えていないので、
-- 既存行の値はそのまま残る。
ALTER TABLE `DispatchSession`
    MODIFY COLUMN `activity` ENUM('WAITING_INPUT', 'WORKING', 'RESPONDED') NULL;
