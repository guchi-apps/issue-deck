import {
  type BackupCiRunStatus,
  type CiGateDecision,
  decideCiGateFromBackupRun,
  parseBackupCiRunStatus,
} from "@/lib/backup-ci/state";

/**
 * 共通チェック`issue-deck/ci-gate`へ、どちらの経路（通常のGitHub Actions／バックアップCI）の結果を
 * 出すかを決める純関数（#4113）。設計は docs/backup-ci.md「5. 必須チェックの移行」。
 *
 * - **採用するのは、最後に始まった試行の結果。** 遅れて届いた古い試行の完了で合否を巻き戻さず、
 *   2つの経路の結果のうち都合のよい成功だけを選ぶこともしない
 * - Actionsは`ci/required-checks.json`（PRのbaseの版）の全グループ＝必須ジョブがそろって成功した
 *   ときだけ成功にする。失敗・キャンセル・スキップ・欠落は成功にしない
 */

/** Actionsの必須ジョブを持つワークフロー。**このファイル以外の実行は数えない**（同名ジョブで合格を作れないように） */
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

export type CiGateSource = "actions" | "backup";

export const CI_GATE_SOURCE_LABELS: Record<CiGateSource, string> = {
  actions: "GitHub Actions",
  backup: "バックアップCI（CircleCI）",
};

export function parseCiGateSource(value: unknown): CiGateSource | null {
  return value === "actions" || value === "backup" ? value : null;
}

/** 1つの経路の、1回の試行から決めた共通チェックの候補 */
export type CiGateCandidate = {
  source: CiGateSource;
  /** 試行の識別子（Actionsは`<run id>:<attempt>`、バックアップCIは`BackupCiRun.id`）。未開始ならnull */
  sourceRef: string | null;
  /** 試行の開始時刻。**新しく始まった方を採用する**。未開始ならnull */
  startedAt: Date | null;
  decision: CiGateDecision;
  targetUrl: string | null;
};

// ---------------------------------------------------------------------------
// GitHub Actions

export type ActionsWorkflowRunInput = {
  id: number;
  runAttempt: number;
  status: string;
  /** その試行（attempt）が始まった時刻。再実行で更新される */
  startedAt: string | null;
  htmlUrl: string | null;
  /** その試行（attempt）のジョブ */
  jobs: { name: string; status: string; conclusion: string | null }[];
};

/** Actionsの実行の一覧（`/actions/runs?head_sha=`の1件）のうち、判定に要る項目 */
export type ActionsWorkflowRunSummary = {
  id: number;
  path: string;
  event: string;
  headSha: string;
  headBranch: string | null;
  pullRequestNumbers: number[];
};

/**
 * PRのheadに対するci.ymlの実行から、判定に使う1件を選ぶ。**最後に作られた実行（idが最大）**
 * を使い、それより前の実行の結論は見ない（成功している方を選び取らない）。
 */
export function selectCiWorkflowRun(
  runs: readonly ActionsWorkflowRunSummary[],
  pr: { number: number; headSha: string; headRef: string },
): ActionsWorkflowRunSummary | null {
  const matched = runs.filter(
    (run) =>
      run.path === CI_WORKFLOW_PATH &&
      run.event === "pull_request" &&
      run.headSha === pr.headSha &&
      // 同じheadを持つ別のPR（main向けなど）の実行を拾わない。フォークのPRは番号が入らないため
      // ブランチ名で照合する
      (run.pullRequestNumbers.length > 0
        ? run.pullRequestNumbers.includes(pr.number)
        : run.headBranch === pr.headRef),
  );
  return matched.reduce<ActionsWorkflowRunSummary | null>((latest, run) => (!latest || run.id > latest.id ? run : latest), null);
}

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);

/**
 * ci.ymlの実行（その試行のジョブ）を、必須ジョブ（`groups`）の合否へまとめる。
 *
 * - 実行が無い・必須ジョブが未完了 → pending
 * - 必須ジョブが失敗・時間切れ → failure
 * - キャンセル・スキップ・中立・実行が終わったのに必須ジョブが無い → error（**成功にしない**）
 * - 全部成功 → success
 */
export function evaluateActionsRun(run: ActionsWorkflowRunInput | null, groups: readonly string[]): CiGateCandidate {
  if (!run) {
    return {
      source: "actions",
      sourceRef: null,
      startedAt: null,
      decision: { state: "pending", description: "GitHub Actionsの必須ジョブの開始を待っています" },
      targetUrl: null,
    };
  }
  const base = {
    source: "actions" as const,
    sourceRef: `${run.id}:${run.runAttempt}`,
    startedAt: parseDate(run.startedAt),
    targetUrl: run.htmlUrl,
  };
  const failed: string[] = [];
  const errored: string[] = [];
  const waiting: string[] = [];
  for (const group of groups) {
    const jobs = run.jobs.filter((job) => job.name === group);
    if (jobs.length === 0) {
      (run.status === "completed" ? errored : waiting).push(group);
      continue;
    }
    if (jobs.some((job) => job.status !== "completed")) {
      waiting.push(group);
    } else if (jobs.some((job) => FAILURE_CONCLUSIONS.has(job.conclusion ?? ""))) {
      failed.push(group);
    } else if (jobs.some((job) => job.conclusion !== "success")) {
      errored.push(group);
    }
  }
  if (failed.length > 0) {
    return { ...base, decision: { state: "failure", description: truncate(`GitHub Actionsの必須ジョブが失敗しました: ${failed.join("、")}`) } };
  }
  if (waiting.length > 0) {
    return { ...base, decision: { state: "pending", description: truncate(`GitHub Actionsで検査中: ${waiting.join("、")}`) } };
  }
  if (errored.length > 0) {
    return {
      ...base,
      decision: {
        state: "error",
        description: truncate(`GitHub Actionsの必須ジョブが完了していません（キャンセル・スキップ等）: ${errored.join("、")}`),
      },
    };
  }
  return { ...base, decision: { state: "success", description: "GitHub Actionsで必須ジョブに合格" } };
}

// ---------------------------------------------------------------------------
// バックアップCI

export type BackupRunForGate = {
  id: string;
  status: string;
  headSha: string;
  baseSha: string;
  statusReason: string | null;
  logUrl: string | null;
  requestedAt: Date;
};

/**
 * PRで最新のバックアップCIの試行から候補を作る。
 *
 * `actionsMirrored`（通常時もActionsの結果を写す）のときは、**今のhead/baseを検査していない試行・
 * 起動を拒否されて検査していない試行を候補にしない**（Actionsの結果へ戻す）。写さないリポジトリでは
 * 従来どおり、その試行から決めた状態（更新されたら`pending`）を出す。
 */
export function backupRunCandidate(
  run: BackupRunForGate | null,
  current: { headSha: string; baseSha: string },
  options: { actionsMirrored: boolean },
): CiGateCandidate | null {
  if (!run) return null;
  const status = parseBackupCiRunStatus(run.status);
  if (!status) return null;
  if (run.headSha !== current.headSha) return null;
  if (options.actionsMirrored && !backupRunCoversCurrent(status, run, current)) return null;
  return {
    source: "backup",
    sourceRef: run.id,
    startedAt: run.requestedAt,
    decision: decideCiGateFromBackupRun({ ...run, status }, current),
    targetUrl: run.logUrl,
  };
}

function backupRunCoversCurrent(
  status: BackupCiRunStatus,
  run: { headSha: string; baseSha: string },
  current: { headSha: string; baseSha: string },
): boolean {
  if (status === "superseded" || status === "trigger_failed") return false;
  return run.headSha === current.headSha && run.baseSha === current.baseSha;
}

// ---------------------------------------------------------------------------
// 採用

/** 前回採用した結果（`CiGateState`の行） */
export type CiGatePrevious = {
  headSha: string;
  baseSha: string;
  source: string;
  sourceRef: string | null;
  sourceStartedAt: Date | null;
  state: string;
};

const TERMINAL_STATES = new Set(["success", "failure", "error"]);

/**
 * 候補のうち、**最後に始まった試行**を採用する（開始時刻が無いものは最も古い扱い。同時刻はActions）。
 *
 * 加えて、同じhead/baseで前回採用した経路と同じ経路の候補が「より古い試行」または「同じ試行の後退
 * （完了→検査中）」なら、前回の採用を保つ。APIの読み取りの遅れで、再実行より前の結果へ戻らないように。
 */
export function chooseCiGateCandidate(
  candidates: readonly (CiGateCandidate | null)[],
  previous: CiGatePrevious | null,
  current: { headSha: string; baseSha: string },
): { candidate: CiGateCandidate; keptPrevious: boolean } | null {
  const present = candidates.filter((c): c is CiGateCandidate => c !== null);
  if (present.length === 0) return null;
  const winner = present.reduce((best, c) => (startedMs(c.startedAt) > startedMs(best.startedAt) ? c : best));
  if (
    !previous ||
    previous.headSha !== current.headSha ||
    previous.baseSha !== current.baseSha ||
    previous.source !== winner.source
  ) {
    return { candidate: winner, keptPrevious: false };
  }
  const older = startedMs(winner.startedAt) < startedMs(previous.sourceStartedAt);
  const regressed =
    previous.sourceRef !== null &&
    previous.sourceRef === winner.sourceRef &&
    TERMINAL_STATES.has(previous.state) &&
    !TERMINAL_STATES.has(winner.decision.state);
  return { candidate: winner, keptPrevious: older || regressed };
}

/** 発行済みかどうかの判定に使うキー。経路・状態・baseのどれかが変われば出し直す */
export function ciGatePublishKey(source: CiGateSource, state: string, baseSha: string): string {
  return `${source}:${state}:${baseSha}`;
}

function startedMs(date: Date | null): number {
  return date ? date.getTime() : Number.NEGATIVE_INFINITY;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function truncate(text: string, max = 140): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
