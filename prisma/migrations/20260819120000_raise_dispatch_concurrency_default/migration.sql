-- AlterTable
-- サブPCのCPU載せ替え（Athlon 200GE 2C/4T → Ryzen 5 PRO 4650G 6C/12T）後の実測
-- （guchi-apps/subpc#19・#1812）を受けて、同時実行数の既定値を2から3へ上げる。
-- 旧既定の2は`next build`単体が4スレッド中2.6を使い切るCPU律速を避けるための値で（#1177）、
-- 12スレッドになった今は3本でもCPUに余裕がある（先に尽きるのはメモリ）。
ALTER TABLE `AppSetting`
    MODIFY COLUMN `dispatchConcurrency` INTEGER NOT NULL DEFAULT 3;

-- UpdateData
-- **列の既定値だけでは動いているインスタンスの挙動が変わらない。** AppSettingは単一行
-- （id=1）で、その行は既に旧既定の2を持っているため、ここで書き換えないと画面から手で
-- 変更するまで2のまま動く。
-- **旧既定のままの行だけを対象にする**（`WHERE dispatchConcurrency = 2`）。人が意図して
-- 別の値を選んでいる場合はその選択を尊重する。3へ上げた結果が合わないときは、アプリ設定
-- ダイアログの「サブPCの同時実行数」から戻せる。
UPDATE `AppSetting` SET `dispatchConcurrency` = 3 WHERE `dispatchConcurrency` = 2;
