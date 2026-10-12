import { isPreviewMode } from "@/lib/preview-mode";
import { createSlackClient } from "@/lib/slack/client";
import { loadSlackConfig } from "@/lib/slack/config";
import { resumeStalePendingRequests } from "@/lib/slack/intake";

/** 待ち状態の依頼を見に行く間隔。止まった行は`PENDING_STALE_MS`を過ぎてから拾うので、それより短くてよい */
const RESUME_INTERVAL_MS = 5 * 60_000;

/**
 * Slack起案で、ack後の処理が途中で止まった依頼（`received`・`resuming`のまま残った行）を拾い直す（#4488）。
 * プロセスの停止・再起動で`after()`の処理が消えても、依頼はack前にDBへ書いてあるので、起動直後と定期実行で続けられる。
 * 連携が未設定の環境と、書き込みを止めたプレビュー環境では動かさない。
 */
export function startSlackIntakeResume(): void {
  const config = loadSlackConfig();
  if (!config || isPreviewMode()) return;
  const ctx = { config, client: createSlackClient(config.botToken) };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const resumed = await resumeStalePendingRequests(ctx);
      if (resumed > 0) console.info(`[slack-intake] 止まっていた依頼を${resumed}件再開しました`);
    } catch (error) {
      console.error("[slack-intake] 止まっていた依頼の確認に失敗しました", error);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 30_000).unref();
  setInterval(() => void tick(), RESUME_INTERVAL_MS).unref();
}
