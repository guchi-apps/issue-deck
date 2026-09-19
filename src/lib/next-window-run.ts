import { formatTimeOfDay, toJstParts } from "@/lib/format-date-time";

/**
 * 次枠実行（#2995）の判定。**時刻を見る判定はすべて`now`を引数で受け取り、ここに閉じる**
 * （`nightly-run.ts`と同じ切り分け）。
 *
 * 「次の5時間枠」に積んだIssueを、**いまの5時間枠の残りが`leadMinutes`分を切ってから**
 * 間隔を空けて1件ずつサブPCへ起動する。起動後はいつもの経路（PR作成→自動レビュー→
 * developへ自動マージ）で進む。
 *
 * ## なぜ「枠の終わり際」に起こすのか
 *
 * Claudeのプラン枠は**時計の境界ではなく、最初のリクエストで始まる**。実測（#2995）でも
 * `anthropic-ratelimit-unified-5h-reset`は08:40のような半端な時刻を返す。つまり**何も
 * 走らせていない時間帯には枠そのものが存在せず**、その5時間ぶんの割り当ては誰にも使われない
 * まま消える。
 *
 * そこで、枠の終わり際にセッションを起こす。こうすると
 *
 * - いまの枠の使い残し（どうせ捨てられるぶん）がまず消費され、
 * - セッションはリセットをまたいで走り続けるので、**次の枠がその時点から始まる**（＝
 *   使われないまま消える枠が減る）、
 * - リセットの瞬間に一斉起動しないので、次の枠を頭から埋めてしまわない。
 *
 * 枠がそもそも動いていないとき（`idle`）は待つ意味が無いのですぐ起動する。その起動自体が
 * 新しい枠の開始になる。
 *
 * ## 判定に使う材料
 *
 * 枠の状況は`src/lib/claude/usage.ts`のヘッダ方式でしか取れない。**Claude Codeの転記JSONLには
 * 使用率もリセット時刻も入っていない**（#2995で全転記を横断確認済み）。取得は最小の推論
 * リクエスト1本なので、**取得そのものが枠を開始する**。次枠実行としては、予約が1件も無いときと
 * OFFのときは呼ばないこと（例外は「5時間枠を開けておく」#3032。`claude-window-keepalive.ts`）。
 */

/** Claudeの5時間枠の長さ。`claude/usage.ts`の`USAGE_WINDOWS`と同じ固定値 */
export const CLAUDE_FIVE_HOUR_WINDOW_MS = 5 * 60 * 60_000;

/**
 * 「枠が始まったばかり」と見なす猶予。
 *
 * 枠が動いていないときに使用量を取りに行くと、**その取得リクエスト自体が新しい枠を開始する**。
 * 直後のレスポンスは「残り5時間・使用率ほぼ0」になるので、リセットまでが
 * `5時間 - この猶予`より長ければ、いま開いたばかりの空の枠＝`idle`として扱う。
 * pollerの巡回間隔（30秒）＋1巡の実処理（実測約14秒）より十分長く取る。
 */
export const NEXT_WINDOW_RUN_FRESH_WINDOW_MS = 3 * 60_000;

/**
 * 予約が生きている時間。これを過ぎても起動できなかった予定は「見送り」にする。
 *
 * 枠の切り替わりは時計と無関係で、積んだ枠が終わるまでに最大5時間、次の枠の終わり際までに
 * さらに最大5時間かかりうるので、24時間は「2回ぶんの枠をまたいでも起動できなかった」ことを
 * 意味する。
 */
export const NEXT_WINDOW_RUN_EXPIRY_HOURS = 24;

/** 画面・判定へ渡す5時間枠のスナップショット */
export type ClaudeWindowSnapshot = {
  /** リセット時刻(epoch ms)。取得できなかった場合はnull */
  resetsAt: number | null;
  /** 使用率(0-100)。取得できなかった場合はnull */
  usedPercent: number | null;
  /** 同じ応答に載っていた週間枠のリセット時刻(epoch ms)（#3100）。無ければnull・省略 */
  weeklyResetsAt?: number | null;
  /** 週間枠の使用率(0-100)。無ければnull・省略 */
  weeklyUsedPercent?: number | null;
};

/**
 * いまの枠がどの段階にあるか。
 *
 * - `unknown`: 取得できなかった。**起動しない**（枠の状況を知らずに起こすと、
 *   リセット直後に一斉起動するのと同じことが起きうる）
 * - `idle`: 枠が動いていない（終わっている／取得した拍子に開いたばかり）。すぐ起動してよい
 * - `waiting`: 枠の途中。終わり際まで待つ
 * - `open`: 枠の残りが`leadMinutes`分以下。起動してよい
 */
export type NextWindowRunPhase = "unknown" | "idle" | "waiting" | "open";

/**
 * 「残り枠の下限」（#3100）に引っかかっている枠。**残りが下限を下回っている間は起動しない**。
 * 日々の作業用に取っておく量を、無人で走る予約実行が食い切らないための歯止め。
 */
export type NextWindowRunQuotaBlock = {
  window: "fiveHour" | "weekly";
  /** 残り（0-100）。使用率から引いた値で、丸めていない */
  remainingPercent: number;
  floorPercent: number;
};

/**
 * 下限に引っかかっている枠を返す（無ければnull）。5時間枠を先に見る。
 *
 * - **5時間枠は`open`（終わり際）のときだけ見る。** `idle`のスナップショットは、終わった前の枠の
 *   使用率か、取得の拍子に開いたばかりの0%の枠で、どちらも「これから起動する枠」の残りではない。
 *   `waiting`はどのみち待つので見る必要が無い
 * - **週間枠はリセット時刻を過ぎていれば見ない**（前の週の使用率が残っているため）。使用率が
 *   取れていないときも見ない（取れない日があっても、下限を設けない場合と同じ動きにとどめる）
 */
export function resolveNextWindowRunQuotaBlock(input: {
  snapshot: ClaudeWindowSnapshot | null;
  phase: NextWindowRunPhase;
  now: Date;
  fiveHourFloorPercent: number;
  weeklyFloorPercent: number;
}): NextWindowRunQuotaBlock | null {
  const { snapshot, phase, now } = input;
  if (!snapshot) return null;

  if (
    phase === "open" &&
    input.fiveHourFloorPercent > 0 &&
    snapshot.usedPercent !== null &&
    Number.isFinite(snapshot.usedPercent)
  ) {
    const remainingPercent = 100 - snapshot.usedPercent;
    if (remainingPercent < input.fiveHourFloorPercent) {
      return { window: "fiveHour", remainingPercent, floorPercent: input.fiveHourFloorPercent };
    }
  }

  const weeklyUsed = snapshot.weeklyUsedPercent ?? null;
  const weeklyResetsAt = snapshot.weeklyResetsAt ?? null;
  const weeklyIsCurrent = weeklyResetsAt === null || weeklyResetsAt > now.getTime();
  if (
    input.weeklyFloorPercent > 0 &&
    weeklyUsed !== null &&
    Number.isFinite(weeklyUsed) &&
    weeklyIsCurrent
  ) {
    const remainingPercent = 100 - weeklyUsed;
    if (remainingPercent < input.weeklyFloorPercent) {
      return { window: "weekly", remainingPercent, floorPercent: input.weeklyFloorPercent };
    }
  }
  return null;
}

/** 見送りの理由（人が読む文）。画面・巡回ログ・予定の待ち理由で同じ文を使う */
export function describeNextWindowRunQuotaBlock(block: NextWindowRunQuotaBlock): string {
  const label = block.window === "fiveHour" ? "5時間枠" : "週間枠";
  return `${label}の残りが${Math.round(block.remainingPercent)}%で、下限の${block.floorPercent}%を下回っています`;
}

export type NextWindowRunWindow = {
  phase: NextWindowRunPhase;
  /** いまの枠のリセット時刻。取得できなかった場合はnull */
  resetsAt: Date | null;
  /** 起動が始まる時刻（`resetsAt`の`leadMinutes`分前）。`waiting`のときだけ入る */
  opensAt: Date | null;
  /**
   * この回のグループ鍵（日本時間・`YYYY-MM-DD HH:mm`）。起動した予定を「どの枠で起こしたか」で
   * 束ねるのに使う（`NightlyRunEntry.nightKey`列）。取得できなかった場合はnull
   */
  runKey: string | null;
  /** 残り枠の下限に引っかかっている枠。無ければnull（#3100） */
  quotaBlock: NextWindowRunQuotaBlock | null;
};

/** `2026-09-18T08:40:00+09:00` → `2026-09-18 08:40`（辞書順＝時刻順になる形） */
export function formatNextWindowRunKey(value: number | string | Date): string | null {
  const parts = toJstParts(value);
  if (!parts) return null;
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const hh = String(parts.hour).padStart(2, "0");
  const mi = String(parts.minute).padStart(2, "0");
  return `${parts.year}-${mm}-${dd} ${hh}:${mi}`;
}

/** `2026-09-18 08:40` → `08:40` （結果の見出しに出す短い形） */
export function formatNextWindowRunKeyLabel(runKey: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(runKey);
  return match ? `${Number(match[1])}/${Number(match[2])} ${match[3]}` : runKey;
}

/**
 * `now`から見た5時間枠の段階を解決する。
 *
 * `idle`になるのは2通りで、どちらも「いま起動してよい」で同じ扱いになる。
 * (1) リセット時刻を過ぎている（枠が終わっている）
 * (2) リセットまでが`5時間 - 猶予`より長い（取得の拍子に開いたばかりの空の枠）
 */
export function resolveNextWindowRunWindow(input: {
  snapshot: ClaudeWindowSnapshot | null;
  now: Date;
  leadMinutes: number;
  /** 残り枠の下限（%・0＝制限しない）。省略は制限しない */
  fiveHourFloorPercent?: number;
  weeklyFloorPercent?: number;
}): NextWindowRunWindow {
  const { snapshot, now, leadMinutes } = input;
  const nowMs = now.getTime();
  const resetsAtMs = snapshot?.resetsAt ?? null;
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) {
    return { phase: "unknown", resetsAt: null, opensAt: null, runKey: null, quotaBlock: null };
  }

  const resetsAt = new Date(resetsAtMs);
  const remainingMs = resetsAtMs - nowMs;
  // 枠が動いていないときの鍵は「ここから始まる枠」のリセット時刻にする。
  // すでに開いている枠ではそのままリセット時刻になるので、同じ枠の中では鍵が変わらない
  const keySource =
    remainingMs <= 0 ? new Date(nowMs + CLAUDE_FIVE_HOUR_WINDOW_MS) : resetsAt;
  const runKey = formatNextWindowRunKey(keySource);
  const withQuota = (phase: NextWindowRunPhase, opensAt: Date | null): NextWindowRunWindow => ({
    phase,
    resetsAt,
    opensAt,
    runKey,
    quotaBlock: resolveNextWindowRunQuotaBlock({
      snapshot,
      phase,
      now,
      fiveHourFloorPercent: input.fiveHourFloorPercent ?? 0,
      weeklyFloorPercent: input.weeklyFloorPercent ?? 0,
    }),
  });

  if (remainingMs <= 0) return withQuota("idle", null);
  if (remainingMs > CLAUDE_FIVE_HOUR_WINDOW_MS - NEXT_WINDOW_RUN_FRESH_WINDOW_MS) {
    return withQuota("idle", null);
  }
  const leadMs = leadMinutes * 60_000;
  const opensAt = new Date(resetsAtMs - leadMs);
  return withQuota(remainingMs <= leadMs ? "open" : "waiting", opensAt);
}

export type NextWindowRunDecision =
  | { action: "launch" }
  | { action: "wait"; reason: string }
  | { action: "skip"; reason: string };

/**
 * 予定1件を、いま起動してよいか。
 *
 * **積んだときの枠では起こさない**（`reservedResetsAt`を過ぎるまで待つ）のが「次の」枠の実体。
 * 枠の状況を取れなかったときは待つだけで、見送りにはしない——取得は一時的に失敗しうるし、
 * 起動しないこと自体は害が無い。
 */
export function decideNextWindowRunLaunch(input: {
  phase: NextWindowRunPhase;
  now: Date;
  /** 予定を積んだ時刻 */
  createdAt: Date;
  /** 積んだ時点の枠のリセット時刻。取れていなければnull */
  reservedResetsAt: Date | null;
  /** 同じ種類で直前に起動した時刻。まだ無ければnull */
  lastLaunchedAt: Date | null;
  leadMinutes: number;
  intervalMinutes: number;
  /** 残り枠の下限に引っかかっている枠（`resolveNextWindowRunWindow`の結果）。省略・nullは制限なし */
  quotaBlock?: NextWindowRunQuotaBlock | null;
}): NextWindowRunDecision {
  const nowMs = input.now.getTime();

  if (nowMs - input.createdAt.getTime() >= NEXT_WINDOW_RUN_EXPIRY_HOURS * 60 * 60_000) {
    return {
      action: "skip",
      reason: input.quotaBlock
        ? describeNextWindowRunQuotaExpired(input.quotaBlock)
        : describeNextWindowRunExpired(),
    };
  }
  if (input.phase === "unknown") {
    return { action: "wait", reason: "Claudeの5時間枠の状況を取得できませんでした" };
  }
  if (input.reservedResetsAt && nowMs < input.reservedResetsAt.getTime()) {
    return {
      action: "wait",
      reason: `積んだときの5時間枠がまだ続いています（${formatTimeOfDay(input.reservedResetsAt)}にリセット）`,
    };
  }
  if (input.phase === "waiting") {
    return {
      action: "wait",
      reason: `5時間枠の残りが${input.leadMinutes}分を切るまで待っています`,
    };
  }
  if (input.quotaBlock) {
    // 見送りではなく待つだけ。残りが下限を上回れば（5時間枠は次の枠、週間枠はリセット）再開する
    return { action: "wait", reason: describeNextWindowRunQuotaBlock(input.quotaBlock) };
  }
  if (input.lastLaunchedAt && input.intervalMinutes > 0) {
    const nextAt = input.lastLaunchedAt.getTime() + input.intervalMinutes * 60_000;
    if (nowMs < nextAt) {
      return {
        action: "wait",
        reason: `直前の起動から${input.intervalMinutes}分空けています（${formatTimeOfDay(new Date(nextAt))}ごろ）`,
      };
    }
  }
  return { action: "launch" };
}

/** 期限切れで見送るときの理由（人が読む文） */
export function describeNextWindowRunExpired(): string {
  return `${NEXT_WINDOW_RUN_EXPIRY_HOURS}時間のあいだに起動できませんでした（サブPCが応答していなかった可能性があります）`;
}

/**
 * 期限切れの時点で残り枠の下限に引っかかっていたときの理由。サブPCの不調と区別する（#3100の計画レビュー）。
 * 下限の待ちは期限を延ばさない（起動できる状態に戻った直後に期限切れで見送るのを避けるため、
 * 待ちの長さで期限を数え直す仕組みは持たない）ので、週間枠のように数日待つ場合はここへ来る。
 */
export function describeNextWindowRunQuotaExpired(block: NextWindowRunQuotaBlock): string {
  return `${NEXT_WINDOW_RUN_EXPIRY_HOURS}時間のあいだ起動できませんでした（${describeNextWindowRunQuotaBlock(block)}。枠が回復してから積み直してください）`;
}

export type NextWindowRunSettings = {
  enabled: boolean;
  leadMinutes: number;
  intervalMinutes: number;
  /** 起動しない残り枠の下限（%・0＝制限しない。#3100） */
  fiveHourFloorPercent: number;
  weeklyFloorPercent: number;
};

/** 画面へ渡す枠の状況（`Date`はISO文字列にする） */
export type NextWindowRunWindowView = {
  phase: NextWindowRunPhase;
  resetsAt: string | null;
  opensAt: string | null;
  usedPercent: number | null;
  /** 週間枠（#3100）。取れていなければnull */
  weeklyUsedPercent: number | null;
  weeklyResetsAt: string | null;
  runKey: string | null;
  quotaBlock: NextWindowRunQuotaBlock | null;
};

export function toNextWindowRunWindowView(
  window: NextWindowRunWindow,
  snapshot: ClaudeWindowSnapshot | null,
): NextWindowRunWindowView {
  return {
    phase: window.phase,
    resetsAt: window.resetsAt?.toISOString() ?? null,
    opensAt: window.opensAt?.toISOString() ?? null,
    usedPercent: snapshot?.usedPercent ?? null,
    weeklyUsedPercent: snapshot?.weeklyUsedPercent ?? null,
    weeklyResetsAt:
      snapshot?.weeklyResetsAt != null ? new Date(snapshot.weeklyResetsAt).toISOString() : null,
    runKey: window.runKey,
    quotaBlock: window.quotaBlock,
  };
}

/**
 * 画面の見出しに出す1行。**OFFのときは枠の話をしない**——止まっているのは枠ではなく設定なので、
 * 「あと1時間47分」と出すと待てば走るように読める。
 */
export function describeNextWindowRunSchedule(
  settings: NextWindowRunSettings,
  window: NextWindowRunWindowView | null,
): string {
  if (!settings.enabled) {
    return "次枠実行はOFFです。積んだIssueはONにしたあと、5時間枠の終わり際から起動します。";
  }
  if (!window || window.phase === "unknown") {
    return "5時間枠の状況を取得できていません。取得できるまで起動しません。";
  }
  if (window.quotaBlock) {
    return `${describeNextWindowRunQuotaBlock(window.quotaBlock)}。残りが下限を上回るまで起動を見送ります。`;
  }
  if (window.phase === "idle") {
    return "いま5時間枠は動いていません。予定はサブPCの次の巡回で起動します（そこから新しい枠が始まります）。";
  }
  if (window.phase === "open") {
    const at = window.resetsAt ? formatTimeOfDay(window.resetsAt) : "";
    return `起動する時間帯です（${at}にリセット）。予定は${settings.intervalMinutes}分おきに1件ずつ起動します。`;
  }
  const opens = window.opensAt ? formatTimeOfDay(window.opensAt) : "";
  const resets = window.resetsAt ? formatTimeOfDay(window.resetsAt) : "";
  return `次は ${opens} から起動します（${resets}にリセット・枠の残り${settings.leadMinutes}分）。`;
}

/**
 * Issue一覧・Issue詳細に出す「次の5時間枠に積まれている」の目印。**`QUEUED`の予定にだけ出す。**
 */
export type NextWindowRunQueuedMark = {
  /** 取り消し（`DELETE /api/nightly-run/:id`）に使う予定の識別子 */
  entryId: string;
  /** 次枠実行そのものが有効か。OFFなら積んであっても起動しない */
  enabled: boolean;
  /** 起動が始まる時刻（ISO文字列）。枠の状況を取れていなければnull */
  opensAt: string | null;
  /** 枠の段階。`idle`は「次の巡回で起動」と出す */
  phase: NextWindowRunPhase;
};

/** 一覧の行に出すチップの文言 */
export function describeNextWindowRunMarkChip(mark: NextWindowRunQueuedMark): string {
  if (!mark.enabled) return "次枠実行OFF";
  if (mark.phase === "idle") return "次枠 まもなく";
  if (mark.opensAt) return `次枠 ${formatTimeOfDay(mark.opensAt)}〜`;
  return "次枠 待機中";
}

/** チップのツールチップ・詳細の注釈で使う1行 */
export function describeNextWindowRunMarkTitle(mark: NextWindowRunQueuedMark): string {
  return mark.enabled
    ? "次の5時間枠に積まれています（枠の終わり際から順に起動）"
    : "次の5時間枠に積まれていますが、次枠実行はOFFです";
}

/** 詳細の注釈に添える説明。何が起きるか・いま開始したいときはどうするか */
export function describeNextWindowRunMarkDetail(mark: NextWindowRunQueuedMark): string {
  return mark.enabled
    ? "いまの5時間枠の終わり際から、積んだ順に1件ずつ起動します。いま開始する場合は先に予定を取り消してください。"
    : "このままでは起動しません。「予約実行」画面で次枠実行をONにするか、予定を取り消してください。";
}
