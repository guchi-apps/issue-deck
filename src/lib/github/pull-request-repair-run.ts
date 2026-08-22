import { db } from "@/lib/db";
import type { RepairKind } from "@/lib/github/pull-request-repair";

/**
 * PRの自動修復がいま走っているか（#2072）。
 *
 * CI失敗の自動修正（`claude-ci-fix.yml`）は失敗を検知して**人の操作なしに**走っているが、
 * 画面にも通知にも赤い「チェック失敗」しか出ないため、放っておけば片付くのか自分で直すのかが
 * 判断できなかった。修復ワークフローに開始・終了を報告させ、その状態をPRのバッジと通知ベルへ出す。
 *
 * **GitHub APIからは引けない。** 自動検知で起動した実行は`workflow_run`イベント発のため、
 * runの`head_branch`・`head_sha`は対象PR（`issue-<番号>`）ではなくデフォルトブランチを指す。
 * runから対象PRへ辿る手段が無いので、走っている側から報告してもらう形にしている。
 */
export type PullRequestRepairRunStatus = "running" | "finished";

/** 画面へ渡す1件ぶん。`PullRequestSummary.repairRun`に載る */
export type PullRequestRepairRunSummary = {
  kind: RepairKind;
  /** 開始時刻（ISO8601）。経過時間の表示に使う */
  startedAt: string;
  /** 実行ログのURL。画面のボタンから起動した直後はまだrunが決まっておらずnull */
  runUrl: string | null;
};

/**
 * 「実行中」と見なす上限（分）。これを過ぎた行は走っていないものとして扱う。
 *
 * 終了の報告はジョブの最後のステップ（`if: always()`）が行い、**キャンセルされた場合も
 * `always()`は走る**ため、報告が届かないのはrunnerごと落ちたときに限られる。それでも
 * `running`のまま残ると「自動修正中」が消えず、修復ボタンも押せないままになるので、
 * 時間で失効させる安全網を置く。
 *
 * 値はGitHub Actionsのジョブの既定タイムアウト（360分）に合わせてある。**実行より先に
 * ピルが消える方が害が大きい**——長引いた実行でバッジだけ消えると、このIssueの困りごと
 * （何が起きているのか分からない）にそのまま戻るため。修復ワークフローは3本とも
 * `timeout-minutes`を持たないので、360分がジョブが生きうる上限そのものになる。
 */
export const REPAIR_RUN_STALE_MINUTES = 360;

/** `kind`として受け付ける値か。DBには文字列で入るため読み出し時にも通す */
export function isRepairKind(value: unknown): value is RepairKind {
  return value === "ci" || value === "conflict";
}

/** 報告された`status`として受け付ける値か */
export function isRepairRunStatus(value: unknown): value is PullRequestRepairRunStatus {
  return value === "running" || value === "finished";
}

/**
 * その行を「いま走っている」として画面に出すか。
 *
 * `finished`の報告が届いていること、または開始から`REPAIR_RUN_STALE_MINUTES`が経っていることの
 * どちらかで走っていない側へ倒す。
 */
export function isRepairRunActive(
  run: { status: string; startedAt: Date },
  now: Date = new Date(),
): boolean {
  if (run.status !== "running") return false;
  return now.getTime() - run.startedAt.getTime() < REPAIR_RUN_STALE_MINUTES * 60_000;
}

/**
 * 修復の開始・終了を記録する。**1つのPR×1つの種別につき1行**を上書きする。
 *
 * 履歴はGitHub ActionsとIssue・PRのコメントに残るため、ここで持つのは「いまの状態」だけでよい。
 * 再実行のたびに行が増えると、画面が読むのは常に最新の1行なのに掃除が要るようになる。
 */
export async function recordPullRequestRepairRun(input: {
  repositoryFullName: string;
  pullRequestNumber: number;
  kind: RepairKind;
  status: PullRequestRepairRunStatus;
  runUrl?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const running = input.status === "running";
  // 終了の報告に実行ログのURLが無いときは、開始時に記録した値を消さない。
  const runUrl = input.runUrl ?? undefined;

  await db.pullRequestRepairRun.upsert({
    where: {
      repositoryFullName_pullRequestNumber_kind: {
        repositoryFullName: input.repositoryFullName,
        pullRequestNumber: input.pullRequestNumber,
        kind: input.kind,
      },
    },
    create: {
      repositoryFullName: input.repositoryFullName,
      pullRequestNumber: input.pullRequestNumber,
      kind: input.kind,
      status: input.status,
      runUrl: runUrl ?? null,
      startedAt: now,
      finishedAt: running ? null : now,
    },
    update: {
      status: input.status,
      ...(runUrl === undefined ? {} : { runUrl }),
      // 開始の報告は毎回`startedAt`を打ち直す（2回目の自動修正の経過時間が1回目から
      // 数え続けてしまわないように）。終了の報告では触らない。
      ...(running ? { startedAt: now, finishedAt: null } : { finishedAt: now }),
    },
  });
}

/** 修復状況を引く対象。PR一覧のように複数まとめて引く */
export type PullRequestRepairRunTarget = {
  repositoryFullName: string;
  pullRequestNumber: number;
};

/** まとめ取りの結果を引くキー。`owner/repo#number` */
export function repairRunKey(repositoryFullName: string, pullRequestNumber: number): string {
  return `${repositoryFullName}#${pullRequestNumber}`;
}

/**
 * いま走っている修復を、対象PRぶんまとめて引く（DBへの問い合わせは1回）。
 *
 * 走っていないPRはキーごと落とすので、呼び出し側は`?? null`で「何も出さない」へ倒す。
 * 同じPRでCI修正とコンフリクト解消が同時に走ることは（同じconcurrencyグループで直列化されて
 * いるため）無いが、万一重なったら開始が新しい方を返す。
 */
export async function fetchActivePullRequestRepairRuns(
  targets: PullRequestRepairRunTarget[],
  now: Date = new Date(),
): Promise<Map<string, PullRequestRepairRunSummary>> {
  const active = new Map<string, PullRequestRepairRunSummary>();
  if (targets.length === 0) return active;

  const rows = await db.pullRequestRepairRun
    .findMany({
      where: {
        // 失効の判定そのものは`isRepairRunActive`が持つ。ここで同じ条件を絞るのは、
        // 終わった行・古い行をDBから引かずに済ませるためだけ。
        status: "running",
        startedAt: { gt: new Date(now.getTime() - REPAIR_RUN_STALE_MINUTES * 60_000) },
        OR: targets.map((target) => ({
          repositoryFullName: target.repositoryFullName,
          pullRequestNumber: target.pullRequestNumber,
        })),
      },
      orderBy: { startedAt: "asc" },
    })
    .catch((error: unknown) => {
      // 修復状況が出ないだけで一覧は返す（CI状態が取れない場合と同じ扱い）。
      console.warn("[fetchActivePullRequestRepairRuns] 取得に失敗しました:", error);
      return [];
    });

  for (const row of rows) {
    if (!isRepairKind(row.kind) || !isRepairRunActive(row, now)) continue;
    // `orderBy`が昇順なので、後から入る新しい行が同じキーを上書きする。
    active.set(repairRunKey(row.repositoryFullName, row.pullRequestNumber), {
      kind: row.kind,
      startedAt: row.startedAt.toISOString(),
      runUrl: row.runUrl,
    });
  }
  return active;
}

/** PR1件ぶん。詳細（`/api/pull-requests/detail`）から使う */
export async function fetchActivePullRequestRepairRun(
  repositoryFullName: string,
  pullRequestNumber: number,
  now: Date = new Date(),
): Promise<PullRequestRepairRunSummary | null> {
  const active = await fetchActivePullRequestRepairRuns(
    [{ repositoryFullName, pullRequestNumber }],
    now,
  );
  return active.get(repairRunKey(repositoryFullName, pullRequestNumber)) ?? null;
}

/**
 * コンフリクト解消の直近の1行を、対象PRぶんまとめて引く（#2116。DBへの問い合わせは1回）。
 *
 * `fetchActivePullRequestRepairRuns`と違い、**終わった行も返す。** 巡回起動
 * （`conflict-sweep.ts`）は「いま走っているか」だけでなく「直前にいつ試したか」も見るため
 * （解消できずに終わったPRへ巡回のたびに起動し直さないようにする）。
 *
 * 1つのPR×`conflict`につき行は1つ（`@@unique`）なので、返るのはPRごとに高々1件。
 */
export async function fetchLatestConflictRepairRuns(
  targets: PullRequestRepairRunTarget[],
): Promise<Map<string, { status: string; startedAt: Date }>> {
  const latest = new Map<string, { status: string; startedAt: Date }>();
  if (targets.length === 0) return latest;

  // **失敗を握り潰さない**（`fetchActivePullRequestRepairRuns`と違う点）。空を返すと抑制が
  // 全部外れ、巡回のたびに同じPRへ起動し直すことになるため、呼び出し側で巡回ごと見送る。
  const rows = await db.pullRequestRepairRun.findMany({
    where: {
      kind: "conflict",
      OR: targets.map((target) => ({
        repositoryFullName: target.repositoryFullName,
        pullRequestNumber: target.pullRequestNumber,
      })),
    },
    select: { repositoryFullName: true, pullRequestNumber: true, status: true, startedAt: true },
  });

  for (const row of rows) {
    latest.set(repairRunKey(row.repositoryFullName, row.pullRequestNumber), {
      status: row.status,
      startedAt: row.startedAt,
    });
  }
  return latest;
}
