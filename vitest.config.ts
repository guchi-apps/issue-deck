import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// ワーカーの本数を機体の規模ではなく**同時に走る本数**に合わせて決める（#2076）。
//
// vitestの既定は「CPU数-1」で、サブPC（12スレッド）では11本のワーカーが立ち、1回の
// `pnpm test:unit`でピーク3.24GiB・12スレッドを使い切る（2026-08-22の実測）。実装セッションは
// 最大12本同時に生きている（`DISPATCH_MAX_SESSIONS`）ため、そのうち2本がテストを始めるだけで
// メモリが尽き、SWAPへ落ちる。
//
// `scripts/heavy-command.sh`が重いコマンドを**同時2本まで**に絞るので、こちらは1本あたりを
// 6ワーカーにして、12スレッドを6×2本へ割り当てる。**CPU数-1は超えない**ので、コア数の少ない
// 環境（CIのubuntu-latestは4コア）ではvitestの既定と同じ本数に落ち着く。
const DEFAULT_MAX_WORKERS = 6;

function resolveMaxWorkers(): number {
  const requested = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10);
  const limit =
    Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_WORKERS;
  return Math.max(1, Math.min(limit, availableParallelism() - 1));
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    maxWorkers: resolveMaxWorkers(),
  },
});
