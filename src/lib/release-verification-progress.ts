import type { ReleaseVerificationKind } from "@/lib/release-merge-gate";

/**
 * リリースの統合検証・全体レビューの進捗（#4277）。結果（`ReleaseVerification`）とは別に、
 * 実行しているジョブ（`DispatchJob`）の状態・時刻と、実行側が`running`報告に載せる工程から作る。
 *
 * **進捗率・残り時間は作らない。** 工程の総量が分からないものに経過時間から百分率を当てると、
 * 進んでいない処理が進んでいるように見える。出すのは「どの工程にいるか」と、数が分かる工程の
 * 件数（検証コマンド 2/3）だけ。**ゲートの判定にも使わない**（判定は`release-merge-gate.ts`）。
 */

export const RELEASE_PROGRESS_STEP_LABEL = {
  prepare: "準備",
  merge: "統合",
  install: "依存関係取得",
  test: "テスト",
  build: "ビルド",
  command: "検証コマンド",
  mac: "Mac検証",
  diff: "差分取得",
  review: "AIレビュー",
  finalize: "結果整理",
} as const;

export type ReleaseProgressStepKey = keyof typeof RELEASE_PROGRESS_STEP_LABEL;

/** 区分ごとに受け付ける工程。別の区分の工程名が混ざった報告は捨てる */
const ALLOWED_STEPS: Record<ReleaseVerificationKind, readonly ReleaseProgressStepKey[]> = {
  integration: ["prepare", "merge", "install", "test", "build", "command", "mac"],
  ai_review: ["prepare", "diff", "review", "finalize"],
};

/** 計画（`plan`）を報告しない古い実行側のための既定の並び */
const DEFAULT_PLAN: Record<ReleaseVerificationKind, readonly ReleaseProgressStepKey[]> = {
  integration: ["prepare", "merge", "command"],
  ai_review: ["prepare", "diff", "review", "finalize"],
};

/** 統合検証の検証コマンドとして数える工程 */
const COMMAND_STEPS: ReadonlySet<ReleaseProgressStepKey> = new Set(["install", "test", "build", "command"]);

const MAX_PLAN_LENGTH = 20;
const MAX_COMMAND_LENGTH = 200;

/** 実行側から届き、`DispatchJob.progress`に保存する形 */
export type ReleaseProgressReport = {
  step: ReleaseProgressStepKey;
  /** これから行う工程の並び。`index`はこの中の位置 */
  plan: ReleaseProgressStepKey[] | null;
  index: number | null;
  /** 統合検証で実行中の検証コマンド（設定の文字列。出力やログは入れない） */
  command: string | null;
  /** 全体レビューの差分のファイル数（処理済み数ではない） */
  files: number | null;
};

/**
 * 受け口と読み出しの両方で通す検証。**知らない工程名・範囲外の位置は捨てる**（画面へ任意の
 * 文字列を出さないため。工程名の表示は`RELEASE_PROGRESS_STEP_LABEL`だけが決める）。
 */
export function parseReleaseProgress(
  kind: ReleaseVerificationKind,
  raw: unknown,
): ReleaseProgressReport | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const allowed = ALLOWED_STEPS[kind];
  const isStep = (v: unknown): v is ReleaseProgressStepKey =>
    typeof v === "string" && (allowed as readonly string[]).includes(v);
  if (!isStep(value.step)) return null;

  const plan =
    Array.isArray(value.plan) && value.plan.length > 0 && value.plan.length <= MAX_PLAN_LENGTH && value.plan.every(isStep)
      ? (value.plan as ReleaseProgressStepKey[])
      : null;
  const index =
    plan && typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 && value.index < plan.length
      && plan[value.index] === value.step
      ? value.index
      : null;
  const command =
    kind === "integration" && typeof value.command === "string" && value.command.trim() !== ""
      ? value.command.trim().slice(0, MAX_COMMAND_LENGTH)
      : null;
  const files =
    kind === "ai_review" && typeof value.files === "number" && Number.isInteger(value.files) && value.files >= 0
      ? value.files
      : null;
  return { step: value.step, plan, index, command, files };
}

export type ReleaseProgressJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "timeout"
  | "canceled";

/** 画面へ渡す進捗。時刻はISO文字列で、経過時間は画面の時計で数える（`viewReleaseProgress`） */
export type ReleaseVerificationProgress = {
  jobStatus: ReleaseProgressJobStatus;
  /** 実行先（受け取ったホスト、まだなら割り当て先）。分からなければnull */
  host: string | null;
  /** 実行先がオンラインか。ホストの記録が無ければnull（＝未取得） */
  hostOnline: boolean | null;
  requestedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  /** 最後に`running`報告が届いた時刻 */
  lastReportAt: string | null;
  finishedAt: string | null;
  /** 実行側の最後の文面（失敗・停止の理由）。終了したジョブのときだけ入れる */
  message: string | null;
  steps: { key: ReleaseProgressStepKey; label: string }[];
  /** `steps`の中の現在位置。工程の報告が無ければnull */
  currentIndex: number | null;
  /** 検証コマンドの何件目か（統合検証のみ） */
  commandPosition: { index: number; total: number } | null;
  command: string | null;
  files: number | null;
  /** 全体レビューを実行しているAI（`claude:opus`の形）。統合検証・不明ならnull */
  agent: string | null;
  /** これより長く報告が無ければ「応答なし」とみなす */
  stalledAfterMs: number;
};

export type ReleaseProgressJobSource = {
  status: string;
  targetHost: string;
  claimedByHost: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  message: string | null;
  progress: unknown;
  agent?: string | null;
  claudeModel?: string | null;
  codexModel?: string | null;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function buildReleaseVerificationProgress(input: {
  kind: ReleaseVerificationKind;
  job: ReleaseProgressJobSource;
  /** 実行先がオンラインか。ホストの記録が無ければnull */
  hostOnline: boolean | null;
  stalledAfterMs: number;
}): ReleaseVerificationProgress {
  const { kind, job } = input;
  const jobStatus = job.status.toLowerCase() as ReleaseProgressJobStatus;
  const report = parseReleaseProgress(kind, job.progress);
  const plan = report?.plan ?? [...DEFAULT_PLAN[kind]];
  let currentIndex = report ? (report.index ?? plan.indexOf(report.step)) : null;
  if (currentIndex === -1) currentIndex = null;

  const commandSlots = plan.flatMap((key, i) => (COMMAND_STEPS.has(key) ? [i] : []));
  const commandPosition =
    currentIndex !== null && COMMAND_STEPS.has(plan[currentIndex]) && commandSlots.length > 0
      ? { index: commandSlots.indexOf(currentIndex) + 1, total: commandSlots.length }
      : null;

  const ended = !["queued", "claimed", "running"].includes(jobStatus);
  return {
    jobStatus,
    host: job.claimedByHost ?? job.targetHost ?? null,
    hostOnline: input.hostOnline,
    requestedAt: job.createdAt.toISOString(),
    claimedAt: iso(job.claimedAt),
    startedAt: iso(job.startedAt),
    lastReportAt: iso(job.heartbeatAt),
    finishedAt: iso(job.finishedAt),
    message: ended ? job.message : null,
    steps: plan.map((key) => ({ key, label: RELEASE_PROGRESS_STEP_LABEL[key] })),
    currentIndex,
    commandPosition,
    command: report?.command ?? null,
    files: report?.files ?? null,
    agent:
      kind === "ai_review" && job.agent
        ? `${job.agent}:${(job.agent === "codex" ? job.codexModel : job.claudeModel) ?? ""}`
        : null,
    stalledAfterMs: input.stalledAfterMs,
  };
}

export type ReleaseProgressPhase = "queued" | "starting" | "running" | "stalled" | "canceled" | "ended";

export type ReleaseProgressView = {
  phase: ReleaseProgressPhase;
  /** 待機中の理由。`null`は「分からない」（画面は「未取得」と出す） */
  waitingReason: string | null;
  /** 現在の工程名（「テスト（検証コマンド 2/3）」など） */
  stepLabel: string | null;
  /** 待機中は依頼から、実行中は開始からの経過。終了後は所要時間 */
  elapsedMs: number | null;
  /** 最後の報告からの経過（実行中・応答なしのみ） */
  sinceLastReportMs: number | null;
};

const ms = (value: string | null) => (value ? new Date(value).getTime() : null);

/**
 * 画面の時計（`nowMs`）で進捗を読む。**止まった処理を「実行中」のまま見せ続けない**——
 * 報告が`stalledAfterMs`より長く途絶えたら`stalled`にし、画面はアニメーションを止める。
 */
export function viewReleaseProgress(progress: ReleaseVerificationProgress, nowMs: number): ReleaseProgressView {
  const current = progress.currentIndex !== null ? progress.steps[progress.currentIndex] : null;
  const stepLabel = current
    ? progress.commandPosition
      ? `${current.label}（検証コマンド ${progress.commandPosition.index}/${progress.commandPosition.total}）`
      : current.label
    : null;
  const host = progress.host ?? "実行先";
  const requested = ms(progress.requestedAt);
  const started = ms(progress.startedAt) ?? ms(progress.claimedAt);
  const lastReport = ms(progress.lastReportAt) ?? started;

  switch (progress.jobStatus) {
    case "queued":
      return {
        phase: "queued",
        waitingReason:
          progress.hostOnline === false
            ? `実行先 ${host} がオフラインです`
            : progress.hostOnline === true
              ? `順番待ち（${host} の受け取り待ち）`
              : null,
        stepLabel: null,
        elapsedMs: requested !== null ? Math.max(0, nowMs - requested) : null,
        sinceLastReportMs: null,
      };
    case "claimed": {
      const claimed = ms(progress.claimedAt);
      const stalled = claimed !== null && nowMs - claimed > progress.stalledAfterMs;
      return {
        phase: stalled ? "stalled" : "starting",
        waitingReason: `起動準備中（${host} が受け取り済み）`,
        stepLabel,
        elapsedMs: requested !== null ? Math.max(0, nowMs - requested) : null,
        sinceLastReportMs: claimed !== null ? Math.max(0, nowMs - claimed) : null,
      };
    }
    case "running": {
      const since = lastReport !== null ? Math.max(0, nowMs - lastReport) : null;
      return {
        phase: since !== null && since > progress.stalledAfterMs ? "stalled" : "running",
        waitingReason: null,
        stepLabel,
        elapsedMs: started !== null ? Math.max(0, nowMs - started) : null,
        sinceLastReportMs: since,
      };
    }
    default: {
      const finished = ms(progress.finishedAt);
      return {
        phase: progress.jobStatus === "canceled" ? "canceled" : "ended",
        waitingReason: null,
        stepLabel,
        elapsedMs: started !== null && finished !== null ? Math.max(0, finished - started) : null,
        sinceLastReportMs: null,
      };
    }
  }
}

/** 「4分05秒」「1時間2分」。0秒未満は0秒 */
export function formatReleaseElapsed(value: number): string {
  const total = Math.max(0, Math.floor(value / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}

/** 記録された担当（`claude:opus`・`codex:gpt-6-sol`）の画面用の表記。読めなければそのまま */
export function formatReleaseReviewAgent(agent: string): string {
  const [name, model] = agent.split(":");
  const label = name === "codex" ? "Codex" : name === "claude" ? "Claude Code" : name;
  return model ? `${label} · ${model}` : label;
}
