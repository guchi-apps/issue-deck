import type { DispatchJobStatus } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionState } from "@/lib/dispatch/session-state";
import { toJstParts } from "@/lib/format-date-time";
import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_TEXT,
  checkUserReason,
} from "@/lib/github/approval-labels";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import {
  ARTIFACT_REQUIRED_LABEL,
  PREVIEW_REQUIRED_LABEL,
  START_IMPLEMENTATION_OPTIONS,
} from "@/lib/github/start-implementation";
import { matchProjectStatus } from "@/lib/issue-progress";

/**
 * 夜間実行（#2772）の判定。**時刻を見る判定はすべて`now`を引数で受け取り、ここに閉じる。**
 *
 * 「今夜の夜間実行」に積んだIssueを、開始時刻（`AppSetting.nightlyRunStartHour`・日本時間）から
 * 3時間の窓のあいだにサブPCへ順に起動する。起動後はいつもの経路（PR作成→自動レビュー→
 * developへ自動マージ）で「本番反映待ち」まで進み、朝は結果を5つに分けて見る。
 *
 * - **JSTへ明示的に変換する。** 本番のVPSもサブPCもCIもUTCで動いている（`format-date-time.ts`）。
 *   `getHours()`をそのまま使うと9時間ずれ、22〜5時のように日付をまたぐ窓では境界の判定も崩れる
 * - **窓を過ぎた予定は翌夜へ持ち越さない**（見送りとして朝に出す）。黙って翌夜に走る方が怖い
 * - **承認・回答を代わりに押す経路は持たない**（`docs/multi-agent/gates.md`）。「計画が必要」の
 *   Issueは計画の投稿で止まり、朝に人が承認する
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 開始時刻から起動を試みる時間。過ぎた予定は「見送り」になる */
export const NIGHTLY_RUN_WINDOW_HOURS = 3;

/**
 * 夜間実行で起動したIssueの確認待ちPushを止めておく朝の時刻（日本時間の「時」）。
 *
 * 計画の投稿は`00.check-user`＋`01.check-plan`を付け、確認待ちのPushは待ちがあれば待ち時間ゼロで
 * 送られる（`notifications/check-user-push.ts`）。夜間実行では01:00に鳴ることになるため、
 * この時刻まで送らない。**朝この時刻に届く通知が、そのまま「手で対応が要るもの」の合図になる。**
 */
export const NIGHTLY_RUN_MORNING_HOUR = 7;

/** 結果を残す日数。これより古い予定の行は起動処理の巡回で消す */
export const NIGHTLY_RUN_RESULT_RETENTION_DAYS = 30;

export type NightlyRunWindow = {
  /** 窓の開始日（日本時間・`YYYY-MM-DD`）。結果を夜ごとに束ねる鍵 */
  nightKey: string;
  /** 窓の開始（直近の開始時刻。まだ来ていなければ前日のもの） */
  startsAt: Date;
  /** 窓の終了（開始＋`NIGHTLY_RUN_WINDOW_HOURS`時間） */
  endsAt: Date;
  /** この夜に起動したIssueのPushを止めておく期限（開始日の翌朝`NIGHTLY_RUN_MORNING_HOUR`時） */
  morningAt: Date;
  /** `now`が窓の中か */
  isOpen: boolean;
  /** 次に窓が開く時刻。開いている間は`startsAt`（すでに始まっている） */
  nextStartsAt: Date;
};

function jstDateKey(ms: number): string {
  const parts = toJstParts(ms);
  if (!parts) return "";
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

/**
 * `now`から見た夜間実行の窓を解決する。
 *
 * 「今日の日本時間`startHour`時」を候補にし、まだ来ていなければ前日のものを取る。
 * 22時開始のように日付をまたぐ窓でも、開始側の日付で`nightKey`が決まる。
 */
export function resolveNightlyRunWindow(now: Date, startHour: number): NightlyRunWindow {
  const parts = toJstParts(now);
  if (!parts) throw new Error("invalid now");
  let startMs = Date.UTC(parts.year, parts.month - 1, parts.day, startHour) - JST_OFFSET_MS;
  if (now.getTime() < startMs) startMs -= DAY_MS;
  const endMs = startMs + NIGHTLY_RUN_WINDOW_HOURS * HOUR_MS;
  const isOpen = now.getTime() >= startMs && now.getTime() < endMs;
  // 開始が夜（22・23時）なら翌日の朝、深夜（0〜5時）なら同じ日の朝
  const morningMs = startMs + ((NIGHTLY_RUN_MORNING_HOUR - startHour + 24) % 24) * HOUR_MS;
  return {
    nightKey: jstDateKey(startMs),
    startsAt: new Date(startMs),
    endsAt: new Date(endMs),
    morningAt: new Date(morningMs),
    isOpen,
    nextStartsAt: new Date(isOpen ? startMs : startMs + DAY_MS),
  };
}

/** `1` → `01:00` */
export function formatNightlyRunHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** 窓の時間帯。`01:00〜04:00` */
export function describeNightlyRunWindowHours(startHour: number): string {
  const endHour = (startHour + NIGHTLY_RUN_WINDOW_HOURS) % 24;
  return `${formatNightlyRunHour(startHour)}〜${formatNightlyRunHour(endHour)}`;
}

/**
 * 夜間実行では進められないオプションのラベル。**人がその場にいないと止まるもの**に限る。
 *
 * - `23.preview-required`: 開発サーバーを起こして画面を確認してもらう工程で止まる。
 *   `merge-policy: relaxed`でも自動マージが止まる
 * - `25.artifact-required`: 見た目の承認を待つ工程で止まる
 *
 * `22.merge-confirm-required`（朝に自分の目で通すための札）と`24.screenshot-required`
 * （セッションだけで完了できる）は入れない。`21.plan-required`も入れない——計画の投稿で
 * 止まって朝に承認する、という使い方は夜間実行の想定に含まれる。
 */
export const NIGHTLY_RUN_BLOCKING_LABELS: readonly string[] = [
  PREVIEW_REQUIRED_LABEL,
  ARTIFACT_REQUIRED_LABEL,
];

function optionLabelTitle(name: string): string {
  return START_IMPLEMENTATION_OPTIONS.find((option) => option.githubLabel === name)?.label ?? name;
}

/**
 * 付いているラベルのうち、夜間実行では進められないものがあればその理由を返す。
 * 積むとき（ダイアログ・API）と起動するとき（夜のあいだに付いたもの）の両方で使う。
 */
export function resolveNightlyRunLabelRejection(
  labels: readonly { name: string }[],
): string | null {
  const blocking = labels
    .map((label) => label.name)
    .filter((name) => NIGHTLY_RUN_BLOCKING_LABELS.includes(name));
  if (blocking.length === 0) return null;
  const titles = blocking.map((name) => `「${optionLabelTitle(name)}」`).join("・");
  return `${titles}は夜間実行では進められません（承認・確認を待つ人がいない）。ラベルを外してから積んでください`;
}

export type NightlyRunLaunchDecision = { action: "launch" } | { action: "skip"; reason: string };

/**
 * 起動する時点で、その予定を起動してよいか。**読むのはGitHub上の実ラベルとIssueの開閉。**
 *
 * 積んだ時点の判定と重ねて置くのは、夜のあいだに状況が変わるため（別のセッションで着手した・
 * closeした・承認待ちになった・`25.artifact-required`が付いた）。判定できない（`issueState`が
 * `null`＝取れなかった）ときは見送る——起動してから止まるより、朝に「見送り」と出る方が軽い。
 */
export function decideNightlyRunLaunch(input: {
  issueState: "open" | "closed" | null;
  labels: readonly { name: string }[];
}): NightlyRunLaunchDecision {
  if (input.issueState === null) {
    return { action: "skip", reason: "Issueの状態を取得できませんでした（GitHubの認証が切れている可能性があります）" };
  }
  if (input.issueState === "closed") {
    return { action: "skip", reason: "Issueがcloseされていました" };
  }
  const names = input.labels.map((label) => label.name);
  if (names.includes(LOCAL_LABEL_NAME)) {
    return { action: "skip", reason: `すでに別のセッションで着手済みでした（${LOCAL_LABEL_NAME}）` };
  }
  if (names.includes(CHECK_USER_LABEL)) {
    const reason = checkUserReason(input.labels);
    return {
      action: "skip",
      reason: `確認待ち（${reason ? CHECK_USER_REASON_TEXT[reason] : CHECK_USER_LABEL}）のままでした`,
    };
  }
  const labelRejection = resolveNightlyRunLabelRejection(input.labels);
  if (labelRejection) return { action: "skip", reason: labelRejection };
  return { action: "launch" };
}

/** 窓を過ぎても起動できなかった予定に付ける理由 */
export function describeNightlyRunWindowMissed(startHour: number): string {
  return `実行時間（${describeNightlyRunWindowHours(startHour)}）のあいだに起動できませんでした（サブPCが応答していなかった可能性があります）`;
}

export type NightlyRunEntryStatus = "QUEUED" | "LAUNCHED" | "SKIPPED" | "CANCELED";

export type NightlyRunOutcomeKind = "ok" | "warn" | "run" | "bad" | "skip";

/** 5分類の見出し。並びは画面に出す順（自動で解決したもの → 人が動くもの） */
export const NIGHTLY_RUN_OUTCOME_ORDER: readonly NightlyRunOutcomeKind[] = [
  "ok",
  "warn",
  "run",
  "bad",
  "skip",
];

export const NIGHTLY_RUN_OUTCOME_LABELS: Record<NightlyRunOutcomeKind, string> = {
  ok: "本番反映待ち",
  warn: "確認が必要",
  run: "実行中",
  bad: "止まった",
  skip: "見送り",
};

export const NIGHTLY_RUN_OUTCOME_DESCRIPTIONS: Record<NightlyRunOutcomeKind, string> = {
  ok: "自動で解決したもの。developへマージ済みで、次のリリースPRに含まれます",
  warn: "人が動くまで進まないもの。理由はいつもの確認待ちと同じです",
  run: "まだセッションが動いている、またはPRの自動レビュー・マージを待っているもの",
  bad: "セッションが最後まで走らなかったもの",
  skip: "起動する時点で条件を満たさなかったもの。必要なら積み直します",
};

export type NightlyRunOutcome = { kind: NightlyRunOutcomeKind; detail: string };

/**
 * 夜に起動した（または見送った）予定の、いまの結果を5つに分ける。
 *
 * 材料はDBにあるものだけ（Issueの同期済みの状態・ジョブ・セッション）。GitHubへは問い合わせない。
 * **判定の順は「確定したものから」**——見送り → closeされた → 確認待ち → 進捗Status → セッション・
 * ジョブの状態。確認待ちを進捗より先に見るのは、`Develop PR`で`22.merge-confirm-required`により
 * 止まっているものを「実行中」ではなく「確認が必要」に出すため。
 */
export function classifyNightlyRunOutcome(input: {
  entry: { status: NightlyRunEntryStatus; skipReason: string | null };
  issue: {
    state: "OPEN" | "CLOSED";
    projectStatus: string | null;
    labels: readonly { name: string }[];
  } | null;
  job: { status: DispatchJobStatus } | null;
  session: { state: DispatchSessionState } | null;
}): NightlyRunOutcome {
  const { entry, issue, job, session } = input;
  if (entry.status === "SKIPPED") {
    return { kind: "skip", detail: entry.skipReason ?? "見送りました" };
  }
  if (entry.status === "CANCELED") {
    return { kind: "skip", detail: "取り消しました" };
  }
  if (entry.status === "QUEUED") {
    return { kind: "run", detail: "起動を待っています" };
  }
  if (!issue) {
    return { kind: "bad", detail: "Issueの情報が見つかりません" };
  }

  const progress = issue.projectStatus ? matchProjectStatus(issue.projectStatus) : null;
  if (issue.state === "CLOSED") {
    return progress === "done"
      ? { kind: "ok", detail: "本番へ反映済み（Issueはclose）" }
      : { kind: "skip", detail: "Issueがcloseされました" };
  }

  if (issue.labels.some((label) => label.name === CHECK_USER_LABEL)) {
    const reason = checkUserReason(issue.labels);
    return { kind: "warn", detail: reason ? `${CHECK_USER_REASON_TEXT[reason]}待ち` : "確認待ち" };
  }

  if (progress === "develop" || progress === "release" || progress === "done") {
    return { kind: "ok", detail: "developへマージ済み" };
  }
  if (progress === "develop-pr") {
    return { kind: "run", detail: "PRの自動レビュー・マージを待っています" };
  }

  if (session?.state === "FAILED") {
    return { kind: "bad", detail: "セッションが異常終了しました（PRなし）" };
  }
  if (session?.state === "EXITED" || session?.state === "GONE") {
    return { kind: "bad", detail: "セッションが終了しましたが、PRが作られていません" };
  }
  if (session?.state === "ALIVE") {
    return { kind: "run", detail: "セッションが動いています" };
  }
  if (job?.status === "FAILED" || job?.status === "TIMEOUT" || job?.status === "CANCELED") {
    return { kind: "bad", detail: "セッションを起動できませんでした" };
  }
  if (job?.status === "QUEUED" || job?.status === "CLAIMED" || job?.status === "RUNNING") {
    return { kind: "run", detail: "サブPCでの起動を待っています" };
  }
  return { kind: "run", detail: "状態を確認しています" };
}

export type NightlyRunSettings = { enabled: boolean; startHour: number };

/** 画面に出す予定・結果1件ぶん */
export type NightlyRunEntryView = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  /** 同期済みのIssueから引けたときだけ入る（`DispatchJobView.issueId`と同じ扱い） */
  issueId: string | null;
  issueTitle: string | null;
  targetHost: string;
  agent: string;
  claudeModel: string | null;
  optionLabels: string[];
  status: NightlyRunEntryStatus;
  nightKey: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** 結果の分類。予定（QUEUED）では`null` */
  outcome: NightlyRunOutcome | null;
};

export type NightlyRunWindowView = {
  nightKey: string;
  startsAt: string;
  endsAt: string;
  isOpen: boolean;
  nextStartsAt: string;
};

export type NightlyRunState = {
  settings: NightlyRunSettings;
  window: NightlyRunWindowView;
  /** 今夜の予定（積んだ順） */
  queued: NightlyRunEntryView[];
  /** 直近の夜の結果。まだ一度も走っていなければ`null` */
  results: { nightKey: string; entries: NightlyRunEntryView[] } | null;
};

export function toNightlyRunWindowView(window: NightlyRunWindow): NightlyRunWindowView {
  return {
    nightKey: window.nightKey,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    isOpen: window.isOpen,
    nextStartsAt: window.nextStartsAt.toISOString(),
  };
}

/**
 * 結果を分類ごとに数える。画面の要約（4枠）に使う。
 */
export function summarizeNightlyRunOutcomes(
  entries: readonly NightlyRunEntryView[],
): Record<NightlyRunOutcomeKind, number> {
  const counts: Record<NightlyRunOutcomeKind, number> = { ok: 0, warn: 0, run: 0, bad: 0, skip: 0 };
  for (const entry of entries) {
    if (entry.outcome) counts[entry.outcome.kind] += 1;
  }
  return counts;
}

/**
 * 処理済みの予定から「直近の夜」の鍵を選ぶ。`nightKey`の辞書順が日付順になる形にしてあるので、
 * 最大値がそのまま最新の夜。
 */
export function selectLatestNightKey(
  entries: readonly { status: NightlyRunEntryStatus; nightKey: string | null }[],
): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (entry.status !== "LAUNCHED" && entry.status !== "SKIPPED") continue;
    if (!entry.nightKey) continue;
    if (latest === null || entry.nightKey > latest) latest = entry.nightKey;
  }
  return latest;
}

/** `optionLabels`列（JSON）を文字列の配列として読む。壊れていれば空 */
export function parseNightlyRunOptionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
