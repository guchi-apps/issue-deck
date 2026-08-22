import {
  CONFLICT_RESOLVE_WORKFLOW_FILE,
  canRepairFromDeck,
  resolveRepairDispatch,
  type RepairDispatch,
} from "@/lib/github/pull-request-repair";
import { isRepairRunActive } from "@/lib/github/pull-request-repair-run";

/**
 * コンフリクトしたPRを**issue-deck側から巡回して見つけ**、コンフリクト解消ワークフローを
 * 起動するかどうかを決める（#2116）。
 *
 * ## なぜGitHub Actionsのトリガーだけでは足りないか
 *
 * `claude-conflict-resolve.yml`は3つの経路で自動起動する
 * （[docs/multi-agent/auto-repair.md](../../../docs/multi-agent/auto-repair.md)）。
 * ところが**PRが作られた瞬間から既にコンフリクトしている**場合、実際に働くのは
 * `pull_request(opened)`と`schedule`の2つだけで、どちらもGitHub側の都合で落ちる。
 *
 * - `pull_request(opened)`: **イベントそのものが配送されないことがある。**
 *   guchi-apps/myroom#191（2026-08-22 11:12:29 UTC作成）では、このPRに対して
 *   `pull_request`起因のrunが**1本も**作られていない（`CI`・`Issue Progress`・
 *   `Claude Conflict Resolve`のいずれも。同じ2分前に作られた別PRでは3本とも走っている）
 * - `schedule`: cronに15分間隔と書いてあっても**そのとおりには走らない。** 同日のmyroomの実測は
 *   08:59・09:35・09:59・10:33・10:59と**24〜36分間隔**で、GitHubの負荷次第でさらに開く
 * - `workflow_run(CI/develop)`: developが動いたときだけ。**PRが最初からコンフリクト
 *   している場合は発火しない**（developは動いていないため）
 *
 * 結果としてmyroom#191は誰にも拾われず、人がissue-deckの画面のボタンを押すまで
 * コンフリクトしたまま残った。**この巡回は、GitHubのイベント配送とスケジューラに依存しない
 * 4本目の検知経路**として置く。既存の3経路は残したままで、先に気づいた方が起動する
 * （どちらから起動しても、ワークフロー側が着手前に対象PRの状態を再確認するため二重に
 * 直しにいくことはない）。
 *
 * ## 対象
 *
 * `issue-<番号>` → `develop`のPRだけ（`resolveRepairDispatch`が
 * `claude-conflict-resolve.yml`を返すもの）。Issueに紐づかないPR（バンプPR・
 * develop→mainのリリースPR）を受け持つ`claude-pr-repair.yml`は、
 * **意図的に自動検知の経路を持たない**設計なので巡回でも起動しない。
 */

/** 起動を見送った理由。ログにそのまま出す（なぜ動かなかったのかを後から追うため） */
export type ConflictSweepSkipReason =
  /** クローズ済み・ドラフト */
  | "not_repairable"
  /** コンフリクトしていない（`mergeable`が未判定のnullもここ） */
  | "not_conflicting"
  /** 自動検知の対象外のPR（`issue-<番号>`→developでない） */
  | "no_auto_workflow"
  /** 対応Issueが`00.check-user`。自動解消を断念した結果であることが多い */
  | "check_user"
  /** 同じPRのコンフリクト解消が既に走っている */
  | "repair_running"
  /** 直前の起動から間が空いていない */
  | "cooldown";

/** 巡回が見るPR1件ぶん。GitHubから取った値をそのまま詰める */
export type ConflictSweepPullRequest = {
  repositoryFullName: string;
  number: number;
  baseRef: string;
  headRef: string;
  state: "open" | "closed";
  draft: boolean;
  /** コンフリクト有無。GitHub側が非同期に計算するため、未判定のあいだは`null` */
  mergeable: boolean | null;
  /** 対応Issueに`00.check-user`が付いているか */
  checkUser: boolean;
};

/** 巡回が参照する、そのPRについての直近の自動修復（`PullRequestRepairRun`の1行） */
export type ConflictSweepRepairRun = {
  status: string;
  startedAt: Date;
};

export type ConflictSweepDecision =
  | { dispatch: true; target: RepairDispatch }
  | { dispatch: false; reason: ConflictSweepSkipReason };

/**
 * 巡回の間隔（分）の既定値。`CONFLICT_SWEEP_INTERVAL_MINUTES`で変えられる。
 *
 * **短くしてもGitHub APIの消費はほぼ増えない**（PR一覧のRESTはETagの条件付きGETが効き、
 * 変化が無ければレート制限を消費しない）が、コンフリクトしているPRが1件でもあると
 * ワークフローの有無の確認が乗るため、既定は5分にしてある。schedule頼みだった従来の
 * 実測（24〜36分）より十分速く、かつ巡回そのものが目立つ負荷にならない値。
 */
export const CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES = 5;

/**
 * 同じPRへ続けて起動しない待ち時間（分）。
 *
 * **解消できずに終わった場合の再試行を、巡回の間隔で回さないため。** コンフリクト解消の
 * ワークフローは`claude-ci-fix.yml`のような試行回数の上限を持たないので、上限の代わりに
 * 間隔で抑える。値は従来の`schedule`の実測間隔（24〜36分）に合わせてあり、
 * **これまでより頻繁に再試行することはない。**
 *
 * 解消に成功したPRはコンフリクトが消えて巡回の対象から外れるため、この待ち時間が効くのは
 * 「試したが直らなかった」ときだけになる。
 */
export const CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES = 30;

/**
 * このPRについて、コンフリクト解消ワークフローを起動するか。
 *
 * **判定は純粋関数に閉じる。** 起動するかどうかの条件（とくに再試行の抑制）は、画面の
 * ボタンから起動する経路（`POST /api/pull-requests/repair`）と違って人の目を通らないため、
 * IOから切り離してテストできる形にしておく。
 */
export function decideConflictSweep(
  pullRequest: ConflictSweepPullRequest,
  context: { repairRun: ConflictSweepRepairRun | null; now: Date },
): ConflictSweepDecision {
  if (!canRepairFromDeck({ state: pullRequest.state, draft: pullRequest.draft })) {
    return { dispatch: false, reason: "not_repairable" };
  }
  // `null`（未判定）は「コンフリクトしていない」側へ倒す。画面のボタンを出さないのと同じ理由で、
  // 判定が出るまで動かさない（次の巡回で拾い直せる）。
  if (pullRequest.mergeable !== false) {
    return { dispatch: false, reason: "not_conflicting" };
  }

  const target = resolveRepairDispatch(
    {
      number: pullRequest.number,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
    },
    "conflict",
  );
  if (target.workflowFile !== CONFLICT_RESOLVE_WORKFLOW_FILE) {
    return { dispatch: false, reason: "no_auto_workflow" };
  }

  // 自動解消を断念したワークフローは対応Issueへ`00.check-user`と`01.check-blocked`を付けて
  // 止まる（`.github/prompts/conflict-resolve.md`「解消できない場合」）。人が見ると決めた
  // ものへ巡回から起動し直さない——同じ理由で断念するだけで、通知だけが増える。
  if (pullRequest.checkUser) {
    return { dispatch: false, reason: "check_user" };
  }

  const { repairRun, now } = context;
  if (repairRun) {
    if (isRepairRunActive(repairRun, now)) {
      return { dispatch: false, reason: "repair_running" };
    }
    if (
      now.getTime() - repairRun.startedAt.getTime() <
      CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES * 60_000
    ) {
      return { dispatch: false, reason: "cooldown" };
    }
  }

  return { dispatch: true, target };
}

/** 巡回の間隔（分）。環境変数が読めない・数値でない場合は既定値 */
export function conflictSweepIntervalMinutes(
  raw: string | undefined = process.env.CONFLICT_SWEEP_INTERVAL_MINUTES,
): number {
  if (raw === undefined || raw.trim() === "") return CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES;
  const value = Number(raw);
  // **0以下は「巡回しない」**として扱う（止めたいときに環境変数だけで止められるように）。
  if (!Number.isFinite(value) || value < 0) return CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES;
  return value;
}
