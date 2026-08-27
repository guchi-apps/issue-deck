-- AlterTable
-- 人が埋めたプレースホルダの値（#2403）。`command`は`<…>`が入ったままのテンプレートで残し、
-- 値はpollerが本文照合を通したあとに`'…'`で包んで穴へ差し込む。
-- シークレットが入りうるため、ジョブが終わった時点でアプリ側が空にする。
ALTER TABLE `DispatchJob` ADD COLUMN `placeholderValues` JSON NULL;

-- AlterTable
-- 埋めた値を差し込んで代行実行できるpollerかどうかの申告（#2403）。
-- NULL（未申告＝古いpoller）は「できない」として扱い、値付きのジョブを払い出さない。
ALTER TABLE `DispatchHost` ADD COLUMN `manualStepValuesCapable` BOOLEAN NULL;
