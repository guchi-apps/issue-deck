import {
  formatTimeOfDay,
  isSameJstDay,
  startOfJstDayMs,
  toJstParts,
} from "@/lib/format-date-time";
import type { Issue } from "@/types/issue";

/**
 * 「いまは実施しない」として項目を伏せる判定（#2398・#2456）。
 *
 * 左メニュー先頭の「ユーザーの確認待ち」（`00.check-user`）と「ユーザーの作業待ち」
 * （`71.manual-step`）に並ぶ項目は、close するか承認・修正依頼を返すまで一覧と件数に載り
 * 続けていた。数週間先まで実施しないと分かっているものまで数に乗るため、
 * 「上から順に手を動かせば盤面が進む」という読み方（`nav-views.ts`の
 * `sidebarAttentionNavViews`）が崩れる。
 *
 * **効かせる範囲はIssue一覧の全ビュー**（#2456）。#2398では要対応の2ビューだけに限って
 * いたが、「すべてのIssue」に並んだままでは日常的に見る一覧から減らず、保留にしても
 * 目に入り続けていた。**伏せたものがどこにも出てこなくなる**という当時の懸念は、
 * どのビューでも一覧の上の1行（`describeSnoozeResume`＋「表示」）から開けることで担保する。
 *
 * **保存先はGitHubのラベルではなくDBのユーザーごとの行**（`SnoozedItem`）。ラベルにすると
 * 全リポジトリへのラベル配布（`docs/cross-repo-setup-guide.md`）が要るうえ、Issueの履歴に
 * 保留の付け外しが残り続ける。
 *
 * **判定はこのファイルの純粋関数だけが持つ。** 件数（`issue-stats.ts`の
 * `computeNavCountsForFilters`）・一覧（`issue-list.tsx`）・通知（`notifications.ts`・
 * `check-user-notification.ts`）が同じ関数を通るので、「メニューからは消えているのに
 * ベルには出ている」という食い違いが起きない。前提待ちの手作業を件数から外している
 * `manual-step-attention.ts`（#1763）と同じ形。
 *
 * **期限切れは行を消さずに時刻で判定する。** `until`を過ぎた行が残っていても
 * `isSnoozeActive`が偽を返すので、何もしなくても件数と通知へ戻る。
 */

/** 保留の対象の種別。DBの`SnoozeTargetKind`（`ISSUE`・`PULL_REQUEST`）と1対1 */
export type SnoozeTargetKind = "issue" | "pull-request";

/** 保留の対象。IssueもPull Requestも「リポジトリ＋番号」で指す */
export type SnoozeTarget = {
  kind: SnoozeTargetKind;
  repositoryFullName: string;
  number: number;
};

/** 保留1件。`until`がnullなら「手動で解除するまで」 */
export type SnoozeEntry = SnoozeTarget & {
  /** 保留が解けて件数・通知へ戻る時刻（ISO8601）。nullは手動解除まで */
  until: string | null;
};

/** 対象 → 保留の引き当て表。作るのは`buildSnoozeMap` */
export type SnoozeMap = ReadonlyMap<string, SnoozeEntry>;

/** 引き当ての鍵。`<種別>:<owner>/<repo>#<番号>` */
export function buildSnoozeKey(target: SnoozeTarget): string {
  return `${target.kind}:${target.repositoryFullName}#${target.number}`;
}

/**
 * 保留の一覧を引き当て表にする。同じ対象が2件あれば後勝ち（DBの一意制約で起きないが、
 * 取得の途中で重複しても壊れないようにしておく）。
 */
export function buildSnoozeMap(entries: readonly SnoozeEntry[]): SnoozeMap {
  return new Map(entries.map((entry) => [buildSnoozeKey(entry), entry] as const));
}

/**
 * その保留がいま効いているか。
 *
 * `until`がnullなら手動で解除するまで効き続ける。時刻を解釈できない値は
 * **効いていない側へ倒す**——読めない値のせいで要対応の項目が永久に消えるより、
 * 出しすぎる方が軽い（`manual-step-attention.ts`の「状態不明は実行できる側に数える」と同じ）。
 */
export function isSnoozeActive(entry: SnoozeEntry, now: number | null): boolean {
  // 現在時刻が未取得（マウント前）のあいだは判定できないので効いていない扱いにする。
  // 保留の一覧自体もマウント後に取るため、これで見た目が変わる瞬間は無い
  if (now === null) return false;
  if (entry.until === null) return true;
  const until = new Date(entry.until).getTime();
  if (Number.isNaN(until)) return false;
  return until > now;
}

/** その対象に効いている保留。無ければnull */
export function findActiveSnooze(
  snoozes: SnoozeMap,
  target: SnoozeTarget,
  now: number | null,
): SnoozeEntry | null {
  const entry = snoozes.get(buildSnoozeKey(target));
  if (!entry) return null;
  return isSnoozeActive(entry, now) ? entry : null;
}

/** そのIssueに効いている保留。無ければnull */
export function findActiveIssueSnooze(
  snoozes: SnoozeMap,
  issue: Pick<Issue, "repositoryFullName" | "number">,
  now: number | null,
): SnoozeEntry | null {
  return findActiveSnooze(
    snoozes,
    { kind: "issue", repositoryFullName: issue.repositoryFullName, number: issue.number },
    now,
  );
}

/**
 * その一覧で保留を効かせるか（#2456）。
 *
 * **ビューは見ない**——効かせるのはIssue一覧の全ビューなので、判定材料は「引き当て表を
 * 受け取っているか」「保留にする操作を受け取っているか」だけ。それでも関数にして配るのは、
 * #2398では同じ`view === "check-user" || view === "manual-step"`が
 * `issue-list.tsx`・`mobile-issue-list-screen.tsx`・`issue-stats.ts`の3か所に散っており、
 * 片方だけ直る事故が実際に起きかけたため。**範囲を変えるときはここだけ直す。**
 */
export function isSnoozeEnabledForList(
  snoozes: SnoozeMap | undefined,
  onSnooze: unknown,
): boolean {
  return Boolean(snoozes && onSnooze);
}

/**
 * 保留中のIssueのid集合（#2398）。
 *
 * **左メニューの件数・一覧・ベル・トーストが同じ集合を読む。** 判定を呼び出し側ごとに
 * 書くと、片方だけ直された時点で数と中身が食い違う（`selectCheckUserRunningIssueIds`と
 * 同じ理由）。
 */
export function selectSnoozedIssueIds(
  issues: readonly Pick<Issue, "id" | "repositoryFullName" | "number">[],
  snoozes: SnoozeMap,
  now: number | null,
): Set<string> {
  const ids = new Set<string>();
  if (snoozes.size === 0 || now === null) return ids;
  for (const issue of issues) {
    if (findActiveIssueSnooze(snoozes, issue, now)) ids.add(issue.id);
  }
  return ids;
}

/**
 * 保留がいつ解けるかの1行（例: `9月1日まで`）。行のチップと詳細の帯に出す。
 *
 * 当日中に戻るものは時刻まで出す——「今日まで」だけだと、いま伏せたばかりのものが
 * すでに戻っているようにも読める。年をまたぐものだけ年を添える。
 */
export function describeSnoozeUntil(until: string | null, now: number | null): string {
  if (until === null) return "手動で解除するまで";
  const parts = toJstParts(until);
  if (parts === null) return "手動で解除するまで";
  if (now !== null && isSameJstDay(until, now)) return `今日 ${formatTimeOfDay(until)}まで`;
  const nowParts = now === null ? null : toJstParts(now);
  const year = nowParts && nowParts.year !== parts.year ? `${parts.year}年` : "";
  return `${year}${parts.month}月${parts.day}日まで`;
}

/**
 * 一覧の1行に添える「いつ戻るか」（例: `最短で9月1日に戻ります`）。
 *
 * 全部が手動解除待ちなら日付を出しようがないので、そう書く。混ざっている場合は
 * **いちばん早く戻るもの**を出す——伏せた項目が次にいつ増えるのかが読めればよく、
 * 全部の期限を並べる場所ではない。
 */
export function describeSnoozeResume(entries: readonly SnoozeEntry[], now: number | null): string {
  const active = entries.filter((entry) => isSnoozeActive(entry, now));
  const times = active
    .map((entry) => (entry.until === null ? null : new Date(entry.until).getTime()))
    .filter((time): time is number => time !== null && !Number.isNaN(time));
  if (times.length === 0) return "手動で解除するまで戻りません";
  const earliest = Math.min(...times);
  const label = describeSnoozeUntil(new Date(earliest).toISOString(), now).replace(/まで$/, "");
  const prefix = times.length < active.length ? "早いもので" : "最短で";
  return `${prefix}${label}に戻ります`;
}

/** 保留メニューの選択肢1つ。`until`がnullなら「手動で解除するまで」 */
export type SnoozePreset = {
  id: string;
  label: string;
  /** 選択肢の右に添える日付（`8/28`）。手動解除はnull */
  hint: string | null;
  until: string | null;
};

/** 日付だけの選択肢の内訳。ラベルと、今日から何日後に戻すか */
const PRESET_DAYS: readonly { id: string; label: string; days: number }[] = [
  { id: "tomorrow", label: "明日まで", days: 1 },
  { id: "three-days", label: "3日後まで", days: 3 },
  { id: "one-week", label: "1週間後まで", days: 7 },
];

/**
 * 保留メニューに並べる選択肢（#2398）。
 *
 * **戻る時刻は日本時間のその日の0:00に揃える。** 「明日まで」を「24時間後」にすると、
 * 押した時刻によって戻る時刻がばらつき、右に添えた日付とも合わなくなる。
 */
export function buildSnoozePresets(now: number): SnoozePreset[] {
  const presets = PRESET_DAYS.flatMap((preset) => {
    const untilMs = startOfJstDayMs(now, preset.days);
    if (untilMs === null) return [];
    const parts = toJstParts(untilMs);
    return [
      {
        id: preset.id,
        label: preset.label,
        hint: parts === null ? null : `${parts.month}/${parts.day}`,
        until: new Date(untilMs).toISOString(),
      } satisfies SnoozePreset,
    ];
  });
  return [...presets, { id: "manual", label: "手動で解除するまで", hint: null, until: null }];
}

/**
 * 日付の入力（`2026-09-01`）を`until`のISO8601へ直す。読めない値はnull。
 *
 * 入力欄が受け取るのは日付だけなので、**その日の0:00（日本時間）に戻す**ものとして扱う。
 * ブラウザのタイムゾーンで解釈すると、UTCで動いている端末から指定したときに9時間ずれる。
 */
export function parseSnoozeUntilDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  if (Number.isNaN(base)) return null;
  return new Date(base - 9 * 60 * 60 * 1000).toISOString();
}

/** 日付入力の初期値（`2026-09-01`）。既定は1週間後 */
export function defaultSnoozeUntilDateValue(now: number): string {
  const parts = toJstParts(startOfJstDayMs(now, 7) ?? now);
  if (parts === null) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}
