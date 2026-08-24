import type { ManualStepVerificationCheck } from "@prisma/client";

import { db } from "@/lib/db";
import {
  buildDispatchActiveKey,
  isActiveDispatchJobStatus,
  isDispatchHostOnline,
} from "@/lib/dispatch/dispatch-job";
import { enqueueManualStepJob } from "@/lib/dispatch/jobs";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import { extractVerificationCommands, type ManualStepCommand } from "@/lib/manual-step-command";
import { resolveManualStepPatrolTarget } from "@/lib/manual-step-verification";

/**
 * openな手作業Issueの`## 完了の確認方法`を定期巡回する（#2008）。
 *
 * 手作業Issueの完了判定は、人が実行して「手作業を完了してクローズ」を押すことだけに
 * 依存していた。**実行したのに押し忘れると誰も気づけない**（#1994は本文の完了条件を
 * 満たしているのにopenのまま残っていた実例）。確認コマンドを1日1回流し、全部が終了コード0で
 * 終わったIssueへ「完了済みの可能性」の印を付けて、押す機会を画面へ戻す。
 *
 * **終了コード0はクローズの理由にしない。** 本文の「期待する出力」との照合はしないので、
 * 0で終わっても完了とは限らない（`extractVerificationCommands`の取り決めをそのまま守る）。
 * 自動でcloseはせず、画面に「完了済みの可能性」として出すところまでで止める。
 * これは#2011（Issueをまたいだ全体実行）とも共通の結論で、**同じ「確認が通った状態」に対する
 * 画面の扱いを両者で揃える**ために、先に着手したこちらで決めている。
 *
 * **実行の口は増やさない。** 流すのは既存の経路（`enqueueManualStepJob` → poller →
 * `POST /api/dispatch/report`）そのままで、この巡回が渡すのも「どの行のコマンドか」だけ。
 * サーバーとサブPCが本文から抽出し直して照合する二重の歯止め（#1828）はそのまま効く。
 *
 * **進めるための常駐プロセスは置かない**（`expireStaleDispatchJobs`・`ManualStepRun`と同じ）。
 * 動かす契機は2つで、どちらも同じ`syncCheck`を通る。
 *
 * - 画面が状態を読むとき（`GET /api/dispatch`）＝巡回の起点
 * - 代行実行の結果報告（`POST /api/dispatch/report`）＝次の1件を積む契機
 */

/** 同じIssueを次に巡回するまでの間隔。1日1回で足りる（実行するのは人で、頻度が上がらない） */
const PATROL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 走ったままの巡回を打ち切るまでの時間。
 *
 * 代行実行そのものは5分（`MANUAL_STEP_TIMEOUT_SECONDS`）で打ち切られるが、**積んだジョブが
 * 誰にも払い出されないまま消えた場合**にここが効く。打ち切らないと、その1件が
 * 「同時に1件だけ」の枠を占め続けて巡回全体が止まる。
 */
const STALE_CHECK_MS = 60 * 60 * 1000;

/** 1回の巡回で見に行くopenな手作業Issueの上限。件数が増えても読み取りを一定に保つ */
const PATROL_CANDIDATE_LIMIT = 200;

/**
 * 次に巡回するIssueを探し直すまでの間隔（プロセス内）。
 *
 * **これは読み取りを減らすためだけの間引きで、正しさはここに依存しない**（プロセスが再起動
 * すれば早めに探し直すだけ）。`GET /api/dispatch`は画面を開いている間20秒ごとに来るのに対し、
 * 巡回は同じIssueを1日1回しか流さない。探す側のクエリ（openな手作業Issueの本文を引く）を
 * 20秒ごとに走らせる理由が無い。
 *
 * **走っている巡回を進める側は間引かない**（`status`の索引だけを引く軽い読み取りで、
 * 取り消し・タイムアウトで終わったジョブに気づけるのがここだけのため）。
 */
const CANDIDATE_SEARCH_INTERVAL_MS = 10 * 60 * 1000;

let lastCandidateSearchAtMs = 0;

/**
 * 巡回を1歩進める（`GET /api/dispatch`から呼ぶ）。
 *
 * **同時に走らせるのは1件だけ。** 確認コマンドはサブPCの実行キューを通るので、巡回が
 * まとめて積むと人が押した実行がその後ろに並ぶ。急ぐ理由が無いぶん、こちらが譲る。
 */
export async function runManualStepVerificationPatrol(now: Date = new Date()): Promise<void> {
  const running = await db.manualStepVerificationCheck.findMany({ where: { status: "RUNNING" } });
  for (const check of running) {
    const synced = await syncCheck(check, now);
    if (synced.status === "RUNNING") return;
  }

  if (now.getTime() - lastCandidateSearchAtMs < CANDIDATE_SEARCH_INTERVAL_MS) return;

  const host = await pickPatrolHost(now);
  if (host === null) return;

  lastCandidateSearchAtMs = now.getTime();
  const target = await findNextPatrolTarget(now);
  if (target === null) return;

  const started = await db.manualStepVerificationCheck.upsert({
    where: {
      repositoryFullName_issueNumber: {
        repositoryFullName: target.repositoryFullName,
        issueNumber: target.issueNumber,
      },
    },
    create: {
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      ...patrolStartValues(host, now),
    },
    update: patrolStartValues(host, now),
  });
  await syncCheck(started, now);
}

function patrolStartValues(hostName: string, now: Date) {
  return {
    targetHost: hostName,
    status: "RUNNING" as const,
    // **前回の記録は引き継がない。** 確認コマンドにはチェックが無いので、引き継ぐと
    // 二度と流れなくなる（`startManualStepRun`が`doneLines`を空にするのと同じ理由）
    doneLines: "[]",
    currentJobId: null,
    message: null,
    startedAt: now,
    finishedAt: null,
  };
}

/**
 * 代行実行の結果報告を受けて、巡回を1歩進める（`POST /api/dispatch/report`から呼ぶ）。
 *
 * **巡回していないIssueでは何もしない**（人が押した実行＝`ManualStepRun`側の担当）。
 */
export async function advanceManualStepVerificationCheck(params: {
  repositoryFullName: string;
  issueNumber: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const check = await findCheck(params.repositoryFullName, params.issueNumber);
  if (!check || check.status !== "RUNNING") return;
  await syncCheck(check, now);
}

/**
 * 人が流した代行実行の結果を、「確認がすべて通った」記録として残す（#2256）。
 *
 * **これまで印を付けられるのは定期巡回だけだった。** 巡回が回るのは確認コマンドが全部
 * 読み取りだけで、実行するデバイスがサブPCのIssueに限られる（`resolveManualStepPatrolTarget`）。
 * それ以外は、手作業アシスタントで確認コマンドを流して**目の前で全部通しても**画面には
 * 何も残らず、`## 完了の確認方法`が本当に通ったのかを後から誰も判断できなかった。
 * 人が押した実行には承認という歯止めがあるぶん、巡回より条件は緩くてよい。
 *
 * **照合は行番号ではなくコマンドの文字列で行う。** 行番号は本文を編集するとずれるので、
 * 中身の違うコマンドの成功を引き継いでしまう。文字列で突き合わせれば、確認コマンドを
 * 書き換えた時点でその1件は未確認へ戻る。
 *
 * **`PASSED`は「完了済みの可能性」までで、クローズはしない**（巡回と同じ取り決め）。
 * 見ているのは終了コードだけで、本文の「期待する出力」との照合はしていない。
 *
 * @returns 記録したら`true`。確認コマンドが無い・まだ全部は通っていない場合は`false`
 */
export async function recordManualStepVerificationPass(params: {
  repositoryFullName: string;
  issueNumber: number;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const issue = await loadManualStepIssue(params.repositoryFullName, params.issueNumber);
  if (issue === null) return false;

  const commands = extractVerificationCommands(issue.body);
  if (commands.length === 0) return false;

  const succeeded = await db.dispatchJob.findMany({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      kind: "MANUAL_STEP",
      status: "SUCCEEDED",
      exitCode: 0,
      finishedAt: { not: null },
    },
    select: { command: true, finishedAt: true, targetHost: true },
    orderBy: { finishedAt: "desc" },
    take: SUCCEEDED_JOB_LOOKBACK,
  });

  const latestByCommand = new Map<string, { finishedAt: Date; targetHost: string }>();
  for (const job of succeeded) {
    if (job.command === null || job.finishedAt === null) continue;
    // `orderBy`が新しい順なので、最初に見つかったものが最新
    if (!latestByCommand.has(job.command)) {
      latestByCommand.set(job.command, { finishedAt: job.finishedAt, targetHost: job.targetHost });
    }
  }

  const matched = commands.map((entry) => latestByCommand.get(entry.command));
  if (matched.some((entry) => entry === undefined)) return false;

  // **揃った時刻は「最後の1件が通った時刻」**。画面はこれを出すので、いちばん古い成功では
  // 新しく見えすぎ、`now`では実行していない時刻を出すことになる
  const finished = matched
    .filter((entry) => entry !== undefined)
    .reduce((latest, entry) => (entry.finishedAt > latest.finishedAt ? entry : latest));

  await db.manualStepVerificationCheck.upsert({
    where: {
      repositoryFullName_issueNumber: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
      },
    },
    create: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      ...passedValues(commands, finished, now),
    },
    update: passedValues(commands, finished, now),
  });
  return true;
}

/** 1つのIssueについて数え直す成功ジョブの上限。同じ確認を何度も流しても最新だけ効く */
const SUCCEEDED_JOB_LOOKBACK = 100;

function passedValues(
  commands: ManualStepCommand[],
  finished: { finishedAt: Date; targetHost: string },
  now: Date,
) {
  return {
    targetHost: finished.targetHost,
    status: "PASSED" as const,
    doneLines: JSON.stringify(commands.map((entry) => entry.stepLine)),
    currentJobId: null,
    message: "代行実行で確認コマンドがすべて成功しました。",
    startedAt: now,
    finishedAt: finished.finishedAt,
  };
}

/** openな手作業Issueとして読めるときだけ本文を返す */
async function loadManualStepIssue(
  repositoryFullName: string,
  issueNumber: number,
): Promise<{ body: string | null } | null> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    select: { id: true },
  });
  if (!repository) return null;

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: issueNumber },
    select: { body: true, state: true, labels: { select: { name: true } } },
  });
  if (!issue || issue.state !== "OPEN") return null;
  if (!issue.labels.some((label) => label.name === MANUAL_STEP_LABEL)) return null;
  return { body: issue.body };
}

/**
 * 走っている巡回をやめる（人がそのIssueの自動実行を始めたとき）。
 *
 * **人の操作を優先する。** `activeKey`はIssue単位なので、巡回が積んだ1件が残っていると
 * 人の実行が`already_queued`で弾かれる。積んだジョブそのものは5分で打ち切られるため
 * ここでは取り消さず、**次の1件を積まない**ことだけを保証する。
 */
export async function abandonManualStepVerificationCheck(params: {
  repositoryFullName: string;
  issueNumber: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const check = await findCheck(params.repositoryFullName, params.issueNumber);
  if (!check || check.status !== "RUNNING") return;
  await db.manualStepVerificationCheck.update({
    where: { id: check.id },
    data: {
      status: "UNAVAILABLE",
      message: "人が自動実行を始めたため、巡回を取りやめました。",
      finishedAt: now,
    },
  });
}

/**
 * 「完了済みの可能性」の印を、Issue一覧へ合流させるための一覧（#1347の順番待ちと同じ形）。
 *
 * @returns `owner/repo#番号` → 確認がすべて通った日時
 */
export async function listManualStepVerifiedAtByIssue(): Promise<Map<string, Date>> {
  const checks = await db.manualStepVerificationCheck.findMany({
    where: { status: "PASSED", finishedAt: { not: null } },
    select: { repositoryFullName: true, issueNumber: true, finishedAt: true },
  });

  const map = new Map<string, Date>();
  for (const check of checks) {
    if (check.finishedAt === null) continue;
    map.set(
      buildDispatchActiveKey(check.repositoryFullName, check.issueNumber),
      check.finishedAt,
    );
  }
  return map;
}

/** 1件ぶんの取得。単票を返す経路（作成・編集・転送）で使う */
export async function getManualStepVerifiedAt(
  repositoryFullName: string,
  issueNumber: number,
): Promise<Date | null> {
  const check = await findCheck(repositoryFullName, issueNumber);
  return check?.status === "PASSED" ? check.finishedAt : null;
}

/**
 * 巡回を1歩進める。**進める条件と止める条件はここ1か所にまとめる**（起点からも報告からも
 * 同じ関数を通す。`syncManualStepRun`と同じ作法）。
 */
async function syncCheck(
  check: ManualStepVerificationCheck,
  now: Date,
): Promise<ManualStepVerificationCheck> {
  if (check.status !== "RUNNING") return check;
  if (now.getTime() - check.startedAt.getTime() > STALE_CHECK_MS) {
    return finishCheck(check, "UNAVAILABLE", "確認コマンドの結果が返らないまま時間切れになりました。", now);
  }

  let current = check;
  if (current.currentJobId !== null) {
    const settled = await settleCurrentJob(current, now);
    if (settled === null) return current;
    current = settled;
    if (current.status !== "RUNNING") return current;
  }

  const target = await loadPatrolTarget(current.repositoryFullName, current.issueNumber);
  if (target === null) {
    // 本文が書き換わって対象から外れた・Issueを引けなくなった＝結論を出せない
    return finishCheck(current, "UNAVAILABLE", "確認コマンドを読めなくなったため取りやめました。", now);
  }

  const doneLines = parseDoneLines(current.doneLines);
  const next = target.find((command) => !doneLines.has(command.stepLine));
  if (next === undefined) {
    // **ここが「完了済みの可能性」。** 全部が終了コード0で終わったというだけで、完了ではない
    return finishCheck(current, "PASSED", null, now);
  }

  const enqueued = await enqueueManualStepJob({
    repositoryFullName: current.repositoryFullName,
    issueNumber: current.issueNumber,
    hostName: current.targetHost,
    stepLine: next.stepLine,
    approvedCommand: next.command,
    // **押した人が居ない。** 巡回が積んだ1件であることは、ここがnullであることで分かる
    requestedByUserId: null,
    now,
  });
  if (!enqueued.ok) {
    return finishCheck(current, "UNAVAILABLE", enqueued.message, now);
  }

  return db.manualStepVerificationCheck.update({
    where: { id: current.id },
    data: { currentJobId: enqueued.job.id },
  });
}

/**
 * 積んである1件の決着をつける。
 *
 * @returns まだ走っている場合は`null`。終わっていれば次へ進める状態にした巡回を返す
 *   （0以外で終わっていれば`FAILED`にしたもの）。
 */
async function settleCurrentJob(
  check: ManualStepVerificationCheck,
  now: Date,
): Promise<ManualStepVerificationCheck | null> {
  const jobId = check.currentJobId;
  if (jobId === null) return check;

  const job = await db.dispatchJob.findUnique({ where: { id: jobId } });
  // ジョブが消えている（保持期間外の掃除など）＝結果を確かめられない。積み直せるようにする
  if (!job) {
    return db.manualStepVerificationCheck.update({
      where: { id: check.id },
      data: { currentJobId: null },
    });
  }
  if (isActiveDispatchJobStatus(job.status)) return null;

  const line = job.manualStepLine;
  if (job.status === "SUCCEEDED" && job.exitCode === 0 && line !== null) {
    return db.manualStepVerificationCheck.update({
      where: { id: check.id },
      data: { currentJobId: null, doneLines: appendDoneLine(check.doneLines, line) },
    });
  }

  // **0以外で終わった＝まだ実施されていない**、がふつうの読み。巡回としてはこれで結論が出た
  // ので、残りの確認コマンドは流さない（1つでも通らなければ「完了済みの可能性」ではない）
  return finishCheck(check, "FAILED", describeFailedJob(job.status, job.exitCode), now);
}

function describeFailedJob(status: string, exitCode: number | null): string {
  if (status === "CANCELED") return "確認コマンドの実行が取り消されました。";
  if (status === "TIMEOUT") return "確認コマンドが時間切れになりました。";
  if (status === "SKIPPED") return "確認コマンドの実行が見送られました。";
  if (exitCode !== null) return `確認コマンドが終了コード ${exitCode} で終わりました。`;
  return "確認コマンドが失敗しました。";
}

async function finishCheck(
  check: ManualStepVerificationCheck,
  status: "PASSED" | "FAILED" | "UNAVAILABLE",
  message: string | null,
  now: Date,
): Promise<ManualStepVerificationCheck> {
  return db.manualStepVerificationCheck.update({
    where: { id: check.id },
    data: { status, message, currentJobId: null, finishedAt: now },
  });
}

/** 積む先のホスト。**代行実行を申告していて応答しているホスト**が居なければ巡回しない */
async function pickPatrolHost(now: Date): Promise<string | null> {
  const hosts = await db.dispatchHost.findMany({ where: { manualStepCapable: true } });
  const online = hosts.find((host) => isDispatchHostOnline(host.lastSeenAt, now));
  return online?.name ?? null;
}

type PatrolTarget = { repositoryFullName: string; issueNumber: number };

/**
 * 次に巡回するIssueを1件選ぶ。
 *
 * **人が触っているIssueは選ばない。** 走っている自動実行（`ManualStepRun`）があるもの、
 * 未処理の代行実行が積まれているものは、こちらが割り込むと人の実行を`already_queued`で
 * 弾いてしまう。
 */
async function findNextPatrolTarget(now: Date): Promise<PatrolTarget | null> {
  const issues = await db.issue.findMany({
    where: { state: "OPEN", labels: { some: { name: MANUAL_STEP_LABEL } } },
    select: {
      number: true,
      body: true,
      repository: { select: { fullName: true } },
    },
    orderBy: { githubUpdatedAt: "asc" },
    take: PATROL_CANDIDATE_LIMIT,
  });
  if (issues.length === 0) return null;

  const candidates = issues.filter(
    (issue) => resolveManualStepPatrolTarget(issue.body, true).patrollable,
  );
  if (candidates.length === 0) return null;

  // **N+1にしない。** 候補ぶんの巡回の記録・自動実行・未処理ジョブをそれぞれ1本で引く
  const [checks, runs, activeJobs] = await Promise.all([
    db.manualStepVerificationCheck.findMany({
      where: {
        OR: candidates.map((issue) => ({
          repositoryFullName: issue.repository.fullName,
          issueNumber: issue.number,
        })),
      },
    }),
    db.manualStepRun.findMany({
      where: {
        status: { in: ["RUNNING", "PAUSED"] },
        OR: candidates.map((issue) => ({
          repositoryFullName: issue.repository.fullName,
          issueNumber: issue.number,
        })),
      },
      select: { repositoryFullName: true, issueNumber: true },
    }),
    db.dispatchJob.findMany({
      where: { activeKey: { not: null } },
      select: { activeKey: true },
    }),
  ]);

  const checkedAt = new Map(
    checks.map((check) => [
      buildDispatchActiveKey(check.repositoryFullName, check.issueNumber),
      check.finishedAt ?? check.startedAt,
    ]),
  );
  const busy = new Set([
    ...runs.map((run) => buildDispatchActiveKey(run.repositoryFullName, run.issueNumber)),
    ...activeJobs.flatMap((job) => (job.activeKey === null ? [] : [stripJobKind(job.activeKey)])),
  ]);

  for (const issue of candidates) {
    const key = buildDispatchActiveKey(issue.repository.fullName, issue.number);
    if (busy.has(key)) continue;
    const last = checkedAt.get(key);
    if (last && now.getTime() - last.getTime() < PATROL_INTERVAL_MS) continue;
    return { repositoryFullName: issue.repository.fullName, issueNumber: issue.number };
  }
  return null;
}

/**
 * `activeKey`から種別の前置きを落として`owner/repo#番号`にする。
 *
 * **種別を問わず「そのIssueで何かが走っている」なら避ける。** 起動ジョブが走っている
 * Issueへ確認コマンドを積んでも実行はできるが、人が見ている実行の後ろに割り込む理由が無い。
 */
function stripJobKind(activeKey: string): string {
  const separator = activeKey.indexOf(":");
  return separator === -1 ? activeKey : activeKey.slice(separator + 1);
}

/** 巡回する確認コマンドを本文から取り直す。対象から外れていれば`null` */
async function loadPatrolTarget(
  repositoryFullName: string,
  issueNumber: number,
): Promise<ManualStepCommand[] | null> {
  const issue = await loadManualStepIssue(repositoryFullName, issueNumber);
  if (issue === null) return null;

  const target = resolveManualStepPatrolTarget(issue.body, true);
  return target.patrollable ? target.commands : null;
}

async function findCheck(
  repositoryFullName: string,
  issueNumber: number,
): Promise<ManualStepVerificationCheck | null> {
  return db.manualStepVerificationCheck.findUnique({
    where: { repositoryFullName_issueNumber: { repositoryFullName, issueNumber } },
  });
}

/** 流し終えた行のJSON配列を読む。**壊れていれば空**（`ManualStepRun`と同じ扱い） */
function parseDoneLines(value: string): Set<number> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((line): line is number => Number.isInteger(line)));
  } catch {
    return new Set();
  }
}

function appendDoneLine(value: string, line: number): string {
  const lines = parseDoneLines(value);
  lines.add(line);
  return JSON.stringify([...lines]);
}
