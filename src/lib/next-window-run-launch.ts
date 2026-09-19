import { db } from "@/lib/db";
import {
  launchScheduledRunEntry,
  markScheduledRunSkipped,
  type NightlyRunLaunchAction,
} from "@/lib/nightly-run-launch";
import {
  decideNextWindowRunLaunch,
  formatNextWindowRunKey,
  resolveNextWindowRunWindow,
  type NextWindowRunPhase,
} from "@/lib/next-window-run";
import {
  readClaudeWindowSnapshot,
  readLastNextWindowLaunchedAt,
  readNextWindowRunSettings,
} from "@/lib/next-window-run-db";

/**
 * 「次の5時間枠」に積んだIssueを、枠の終わり際に起動ジョブへ変換する（#2995）。
 *
 * 契機は`POST /api/dispatch/claim`への相乗り。1件ぶんの手順（実ラベルの判定 →
 * `enqueueDispatchJob`→`11.local`）は`launchScheduledRunEntry`を使う。
 *
 * **1回の巡回で起動するのは1件まで。** リセットの瞬間に全部走らせないための間隔
 * （`nextWindowRunIntervalMinutes`）はここで測る。間隔が0でも1件ずつにするのは、
 * 同じ巡回で複数積むとサブPCの同時実行数の上限に一気に当たるため。
 */

export type NextWindowRunLaunchResult = {
  enabled: boolean;
  phase: NextWindowRunPhase;
  runKey: string | null;
  actions: NightlyRunLaunchAction[];
};

export async function launchNextWindowRunEntries(params: {
  hostName: string;
  now?: Date;
}): Promise<NextWindowRunLaunchResult> {
  const now = params.now ?? new Date();
  const settings = await readNextWindowRunSettings();
  const result: NextWindowRunLaunchResult = {
    enabled: settings.enabled,
    phase: "unknown",
    runKey: null,
    actions: [],
  };
  // OFFのあいだは予定を残したまま何もしない（期限切れの見送りも付けない。ONにしてから走る）
  if (!settings.enabled) return result;

  const entries = await db.nightlyRunEntry.findMany({
    where: { status: "QUEUED", kind: "NEXT_WINDOW", targetHost: params.hostName },
    orderBy: { createdAt: "asc" },
  });
  // **予定が無いときは枠を取りに行かない。** 取得は最小の推論リクエスト1本で、
  // 送信そのものが5時間枠を開始してしまう（`next-window-run-db.ts`）
  if (entries.length === 0) return result;

  const snapshot = await readClaudeWindowSnapshot();
  const window = resolveNextWindowRunWindow({
    snapshot,
    now,
    leadMinutes: settings.leadMinutes,
    fiveHourFloorPercent: settings.fiveHourFloorPercent,
    weeklyFloorPercent: settings.weeklyFloorPercent,
  });
  result.phase = window.phase;
  result.runKey = window.runKey;

  const lastLaunchedAt = await readLastNextWindowLaunchedAt(params.hostName);

  for (const entry of entries) {
    const decision = decideNextWindowRunLaunch({
      phase: window.phase,
      now,
      createdAt: entry.createdAt,
      reservedResetsAt: entry.reservedResetsAt,
      lastLaunchedAt,
      leadMinutes: settings.leadMinutes,
      intervalMinutes: settings.intervalMinutes,
      quotaBlock: window.quotaBlock,
    });

    if (decision.action === "skip") {
      // 期限切れ。**枠を取れないまま24時間経った場合でも結果として残す**ため、
      // 鍵が無いときは「いま」を鍵にする（画面の「見送り」に出す先が要る）
      const skipKey = window.runKey ?? formatNextWindowRunKey(now) ?? "";
      await markScheduledRunSkipped(entry.id, skipKey, decision.reason, now);
      result.actions.push({
        entryId: entry.id,
        repositoryFullName: entry.repositoryFullName,
        issueNumber: entry.issueNumber,
        result: "skipped",
        detail: decision.reason,
      });
      continue;
    }
    if (decision.action === "wait") {
      // 待つ理由は先頭の1件だけ見れば足りる（後続も同じ枠・同じ間隔で待つ）
      if (result.actions.length === 0) {
        result.actions.push({
          entryId: entry.id,
          repositoryFullName: entry.repositoryFullName,
          issueNumber: entry.issueNumber,
          result: "deferred",
          detail: decision.reason,
        });
      }
      continue;
    }

    if (window.runKey === null) continue; // launchなら必ず鍵はあるが、型の上では起こりうる
    const outcome = await launchScheduledRunEntry({
      entry,
      kind: "NEXT_WINDOW",
      runKey: window.runKey,
      hostName: params.hostName,
      now,
    });
    if (!outcome.reserved) continue;
    if (outcome.action) result.actions.push(outcome.action);
    // 起動できたら、この巡回はここで終わり（次は間隔ぶん空けてから）。
    // 見送り・持ち越しになった場合だけ次の予定を試す
    if (outcome.action?.result === "launched" || outcome.stop) break;
  }

  return result;
}
