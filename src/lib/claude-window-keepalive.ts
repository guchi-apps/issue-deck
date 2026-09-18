import { formatTimeOfDay, toJstParts } from "@/lib/format-date-time";

/**
 * 5時間枠を開けておく（#3032・guchi-apps/question#69の案B）の判定。**時刻を見る判定はすべて
 * `now`を引数で受け取り、ここに閉じる**（`next-window-run.ts`と同じ切り分け）。
 *
 * Claudeのプラン枠は**最初のリクエストで始まる**（`next-window-run.ts`の冒頭を参照）。作業を
 * 始める前に枠を開けておくと、同じ量を使っても上限に当たったときのリセットが早く来る。
 * そこで、指定した時間帯のあいだ枠が止まっていれば、pollerの巡回（`POST /api/dispatch/claim`）の
 * ついでに最小の推論リクエスト（`claude/usage.ts`の探り）を1本送って枠を開ける。
 *
 * - **週間枠の総量は増えない。** 増えるのは「短時間に集中して使える量」だけ
 * - **枠が動いている間は送らない。** 最後に見たリセット時刻を過ぎるまで待つので、送るのは
 *   5時間に1本（リセット後の最初の巡回）で済む
 * - **夜間は既定で開けない**（7:00〜23:00）。寝ている間の枠は次枠実行で使うほうが得なため
 */

export type ClaudeWindowKeepAliveSettings = {
  enabled: boolean;
  /** 開ける時間帯の開始（日本時間の時・0〜23） */
  startHour: number;
  /** 開ける時間帯の終了（日本時間の時・0〜23。この時刻ちょうどは含まない） */
  endHour: number;
};

/**
 * 探りが失敗し続けたときに送り直すまでの間隔。取得に失敗するとリセット時刻が分からないままに
 * なり、pollerの巡回（30秒）ごとに送ってしまうため、最後に送ってからこれだけ空ける。
 * `claude/usage.ts`のキャッシュ（5分）と揃える。
 */
export const CLAUDE_WINDOW_KEEPALIVE_RETRY_MS = 5 * 60_000;

/** `now`が時間帯の中か。開始＝終了は終日、開始＞終了は日付をまたぐ（22〜6など） */
export function isWithinClaudeWindowKeepAliveHours(
  settings: Pick<ClaudeWindowKeepAliveSettings, "startHour" | "endHour">,
  now: Date,
): boolean {
  const hour = toJstParts(now)?.hour;
  if (hour === undefined) return false;
  const { startHour, endHour } = settings;
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export type ClaudeWindowKeepAliveDecision =
  | { action: "probe" }
  | { action: "skip"; reason: "off" | "outside_hours" | "window_open" | "recently_probed" };

/**
 * いま枠を開ける探りを送るか。
 *
 * `knownResetsAt`は**取得せずに**分かっている最後のリセット時刻（`peekClaudeFiveHourWindow`）。
 * 取れていない（起動直後・取得失敗）ときは送ってよいが、`lastProbedAt`から
 * `CLAUDE_WINDOW_KEEPALIVE_RETRY_MS`は空ける。
 */
export function decideClaudeWindowKeepAlive(input: {
  settings: ClaudeWindowKeepAliveSettings;
  now: Date;
  knownResetsAt: number | null;
  lastProbedAt: Date | null;
}): ClaudeWindowKeepAliveDecision {
  const { settings, now, knownResetsAt, lastProbedAt } = input;
  if (!settings.enabled) return { action: "skip", reason: "off" };
  if (!isWithinClaudeWindowKeepAliveHours(settings, now)) {
    return { action: "skip", reason: "outside_hours" };
  }
  const nowMs = now.getTime();
  if (knownResetsAt !== null && nowMs < knownResetsAt) {
    return { action: "skip", reason: "window_open" };
  }
  if (lastProbedAt && nowMs - lastProbedAt.getTime() < CLAUDE_WINDOW_KEEPALIVE_RETRY_MS) {
    return { action: "skip", reason: "recently_probed" };
  }
  return { action: "probe" };
}

/** `7` → `7:00` */
export function formatClaudeWindowKeepAliveHour(hour: number): string {
  return `${hour}:00`;
}

function formatHours(settings: ClaudeWindowKeepAliveSettings): string {
  return settings.startHour === settings.endHour
    ? "終日"
    : `${formatClaudeWindowKeepAliveHour(settings.startHour)}〜${formatClaudeWindowKeepAliveHour(settings.endHour)}`;
}

/** 画面へ渡す状態 */
export type ClaudeWindowKeepAliveView = {
  settings: ClaudeWindowKeepAliveSettings;
  /** いま時間帯の中か（サーバーの`now`で判定） */
  withinHours: boolean;
  /** 最後に枠を開ける探りを送った時刻（ISO文字列）。まだ無ければnull */
  probedAt: string | null;
  /**
   * いまの枠が動いていればそのリセット時刻（ISO文字列）。止まっている・取りに行っていない
   * （OFF・時間帯の外で、次枠実行の予定も無い）ときはnull
   */
  runningUntil: string | null;
};

/** いまの枠が動いていればそのリセット時刻。`resetsAt`は枠メーターと同じ値（epoch ms） */
export function resolveClaudeWindowRunningUntil(resetsAt: number | null, now: Date): Date | null {
  return resetsAt !== null && resetsAt > now.getTime() ? new Date(resetsAt) : null;
}

/** 節の見出しの下に出す1行。**OFFのときは枠の話をしない**（`describeNextWindowRunSchedule`と同じ） */
export function describeClaudeWindowKeepAlive(view: ClaudeWindowKeepAliveView): string {
  const { settings } = view;
  if (!settings.enabled) {
    return "OFFです。ONにすると、指定した時間帯のあいだ5時間枠が止まっていれば自動で開けます。";
  }
  const hours = formatHours(settings);
  if (!view.withinHours) {
    return `いまは時間帯の外です（${hours}）。${formatClaudeWindowKeepAliveHour(settings.startHour)}以降の最初の巡回で枠を開けます。`;
  }
  const head = `${hours === "終日" ? "終日" : `${hours}のあいだ`}、枠が止まっていれば最小のリクエストで開けます。`;
  if (view.runningUntil) {
    return `${head}いまの枠は${formatTimeOfDay(view.runningUntil)}にリセットし、その後の巡回で次の枠を開けます。`;
  }
  return `${head}サブPCの次の巡回で開けます。`;
}
