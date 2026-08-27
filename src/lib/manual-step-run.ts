import type { ManualStepRun } from "@prisma/client";

import { db } from "@/lib/db";
import {
  describeManualStepExecutionRejection,
  isActiveDispatchJobStatus,
  isDispatchHostOnline,
  type ManualStepExecutionRejection,
} from "@/lib/dispatch/dispatch-job";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import {
  cancelDispatchJob,
  enqueueManualStepAbortJob,
  enqueueManualStepJob,
} from "@/lib/dispatch/jobs";
import { updateIssue } from "@/lib/github/issues-api";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";
import {
  buildManualStepRunPlan,
  findManualStepEntry,
  findNextManualStepEntry,
  type ManualStepRunEntry,
  type ManualStepRunPlan,
} from "@/lib/manual-step-autorun";
import { MANUAL_STEP_TIMEOUT_SECONDS } from "@/lib/manual-step-command";
import type { ManualStepRunView } from "@/lib/manual-step-run-view";
import { abandonManualStepVerificationCheck } from "@/lib/manual-step-verification-patrol";
import { toggleTaskListLine } from "@/lib/markdown-task-list";

/**
 * 手作業アシスタントの自動実行（#1869）を**サーバーが進める**（#1882）。
 *
 * #1869の時点では、承認1回ぶんの状態を持つのは画面だけだった（ダイアログを閉じれば止まる）。
 * 「自動実行中に画面を閉じたい・そのとき進行状況を確認したい」という要望（#1882）を受け、
 * **状態をDBへ置き、進めるのはサーバー**と決めた。代行実行の結果報告（`POST /api/dispatch/report`）を
 * 受けた時点で次の1件を積むので、ブラウザを閉じても・別の端末から開いても、追っているのは
 * 同じ1本の実行になる。
 *
 * **判定は画面と同じ純粋関数（`lib/manual-step-autorun.ts`）から作る。** ここに条件を書き足すと、
 * 承認パネルに並んだものと実際に実行されるものがずれる。
 *
 * **進めるための常駐プロセスは置かない**（`expireStaleDispatchJobs`と同じ方針）。動かす契機は
 * 次の2つだけで、どちらも同じ`syncManualStepRun`を通る。
 *
 * - 代行実行の結果報告（成功なら次を積み、失敗ならそこで止める）
 * - 画面が状態を読むとき（`listManualStepRunViews`）。取り消し・タイムアウトで終わったジョブと、
 *   **Issueがcloseされて用済みになった`PAUSED`の実行**（#2073・`sweepClosedManualStepRuns`）を
 *   ここで拾う（どちらも報告が来ない終わり方なので、報告を契機にできない）
 *
 * **最後まで流れてもクローズはしない。** 完了の確認は人が読み、クローズも人が押す（#1869の
 * 取り決めをそのまま守る）。
 */


/** Issueがcloseされて片付けた実行に残す一文（#2073）。中断と区別が付くようにする */
const CLOSED_ISSUE_STOP_MESSAGE = "手作業のIssueがクローズされたため、自動実行を終わりにしました。";

export type ManualStepRunActionResult =
  | { ok: true; run: ManualStepRunView }
  | { ok: false; message: string };

/**
 * 自動実行を始める（画面の「承認してN件を自動実行」）。
 *
 * **同じIssueの前回の実行は上書きする。** 1つのIssueにつき1行（`@@unique`）で、
 * 「いつ何を実行したか」の履歴は`DispatchJob`側に残るため、ここに履歴を溜める必要が無い。
 */
export async function startManualStepRun(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  userId: string | null;
  diagnoseConsent: boolean;
  now?: Date;
}): Promise<ManualStepRunActionResult> {
  const now = params.now ?? new Date();
  const values = {
    targetHost: params.hostName,
    status: "RUNNING" as const,
    pausedReason: null,
    // **流し終えた記録は毎回まっさらにする。** 前回の`doneLines`を引き継ぐと、確認コマンド
    // （チェックが付かない）が「もう流した」ことになって二度と実行されない
    doneLines: "[]",
    diagnoseConsent: params.diagnoseConsent,
    startedByUserId: params.userId,
    currentJobId: null,
    message: null,
    startedAt: now,
    finishedAt: null,
  };
  const run = await db.manualStepRun.upsert({
    where: {
      repositoryFullName_issueNumber: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
      },
    },
    create: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      ...values,
    },
    update: values,
  });

  // 完了確認の巡回（#2008）が同じIssueを流していたら取りやめる。**人の操作を優先する**——
  // `activeKey`はIssue単位なので、巡回が次の1件を積み続けると人の実行が`already_queued`で弾かれる
  await abandonManualStepVerificationCheck({
    repositoryFullName: params.repositoryFullName,
    issueNumber: params.issueNumber,
    now,
  });

  const synced = await syncManualStepRun(run, now);
  return { ok: true, run: await toRunView(synced, now) };
}

/**
 * 自動実行を中断する（#1882）。
 *
 * **次を積まないだけでなく、走っている1件も止める。** 順番待ち・払い出し済みのジョブは
 * 取り消し（`cancelDispatchJob`）、既に走っているものは中断ジョブ（`MANUAL_STEP_ABORT`）を
 * 積んでpollerに止めてもらう。**止められないホスト（未対応のpoller・応答が無い）でも
 * 中断そのものは成立する**——次を積むのをやめる、という意味では止まっているため。
 * 走っている1件がどうなるかは`message`で伝える（打ち切りは`MANUAL_STEP_TIMEOUT_SECONDS`）。
 */
export async function stopManualStepRun(params: {
  repositoryFullName: string;
  issueNumber: number;
  userId: string | null;
  now?: Date;
}): Promise<ManualStepRunActionResult> {
  const now = params.now ?? new Date();
  const run = await findRun(params.repositoryFullName, params.issueNumber);
  if (!run) return { ok: false, message: "この手作業の自動実行は見つかりませんでした。" };

  const message = await stopCurrentJob(run, params.userId, now);
  const stopped = await db.manualStepRun.update({
    where: { id: run.id },
    data: { status: "STOPPED", pausedReason: null, message, finishedAt: now },
  });
  return { ok: true, run: await toRunView(stopped, now) };
}

/**
 * 止まっていた自動実行を続きから流す。
 *
 * 人が手元で実行して「実行した・次へ」を押したとき、失敗を直して「もう一度実行」したとき、
 * Claudeの修正案を適用したときに呼ばれる。**中断した実行（`STOPPED`）は再開しない**——
 * 止めると決めたものを、別のボタンの副作用で動かし直さない（もう一度承認してもらう）。
 */
export async function resumeManualStepRun(params: {
  repositoryFullName: string;
  issueNumber: number;
  now?: Date;
}): Promise<ManualStepRunActionResult> {
  const now = params.now ?? new Date();
  const run = await findRun(params.repositoryFullName, params.issueNumber);
  if (!run) return { ok: false, message: "この手作業の自動実行は見つかりませんでした。" };
  if (run.status !== "PAUSED") {
    return { ok: true, run: await toRunView(await syncManualStepRun(run, now), now) };
  }

  const resumed = await db.manualStepRun.update({
    where: { id: run.id },
    data: {
      status: "RUNNING",
      pausedReason: null,
      message: null,
      // **失敗した1件は忘れる。** 直したものをもう一度積み直せるようにする
      currentJobId: null,
    },
  });
  return { ok: true, run: await toRunView(await syncManualStepRun(resumed, now), now) };
}

/**
 * 代行実行の結果報告を受けて、自動実行を1歩進める（`POST /api/dispatch/report`から呼ぶ）。
 *
 * **自動実行が動いていないIssueでは何もしない**（手順ごとに「承認して実行」を押す従来の
 * 使い方＝#1828のまま）。
 */
export async function advanceManualStepRun(params: {
  repositoryFullName: string;
  issueNumber: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const run = await findRun(params.repositoryFullName, params.issueNumber);
  if (!run || run.status !== "RUNNING") return;
  await syncManualStepRun(run, now);
}

/**
 * 画面へ返す自動実行の一覧（`GET /api/dispatch`）。
 *
 * **取得口を増やさない**（#1217のセッションと同じ理由）。画面は`use-dispatch-state.ts`の1本で
 * 状態を読んでおり、ここを別のエンドポイントにすると同じ画面のためにポーリングが2本走る。
 *
 * 走っている実行は**読むついでに1歩進める**。取り消し・タイムアウトで終わったジョブは報告が
 * 来ないため、報告を契機にした前進だけでは止まったことに誰も気づけない。
 *
 * **返すのは`RUNNING`と`PAUSED`だけ**（#2073）。#1882では終わった実行も30分は返していたが、
 * それを描いていたのは実行キューの節だけで、その節を撤去した。残る読み手（アシスタントの
 * `AutoRunBar`・一覧入口のバッジ）はどちらも`isActiveManualStepRun`で弾くため、窓を残すと
 * **誰も描かない行に`toRunView`（Repository・Issue・DispatchHostの3クエリ＋実行計画の再構築）を
 * 5〜20秒ごとに回すだけ**になる。中断・完了を押した直後の表示は`controlManualStepRun`が
 * 応答をその場で状態へ反映する経路が持っているので、押した本人の体感は変わらない。
 */
export async function listManualStepRunViews(now: Date = new Date()): Promise<ManualStepRunView[]> {
  const runs = await sweepClosedManualStepRuns(
    await db.manualStepRun.findMany({
      where: { status: { in: ["RUNNING", "PAUSED"] } },
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
    now,
  );

  const views: ManualStepRunView[] = [];
  for (const run of runs) {
    const synced = run.status === "RUNNING" ? await syncManualStepRun(run, now) : run;
    views.push(await toRunView(synced, now));
  }
  return views;
}

/**
 * 手作業Issueがcloseされた`PAUSED`の実行を終わりにする（#2073）。
 *
 * **`PAUSED`は自分では終わらない。** 人が手元で手順を実行して「実行した・次へ」を押すか、
 * 「中断する」を押すまで残り続ける仕様で、押さずにIssueだけcloseすると実行の行が居座った。
 * 居座った行は`hasActiveJob`（`use-dispatch-state.ts`）を立て続けるため、開いている画面の
 * 自動更新が5秒間隔のまま戻らないという実害がある（表示だけの問題ではない）。
 *
 * **closeを契機にした常駐処理は置かない**（`syncManualStepRun`と同じ方針）。ここで一覧を
 * 読むついでに片付ける。`RUNNING`は対象にしない——走っているジョブを止める段取りが要り、
 * それは「中断する」（`stopManualStepRun`）の仕事だから。
 *
 * 問い合わせは件数によらず2本（リポジトリ→closeされたIssue）に抑える。
 */
async function sweepClosedManualStepRuns(
  runs: ManualStepRun[],
  now: Date,
): Promise<ManualStepRun[]> {
  const paused = runs.filter((run) => run.status === "PAUSED");
  if (paused.length === 0) return runs;

  const repositories = await db.repository.findMany({
    where: { fullName: { in: [...new Set(paused.map((run) => run.repositoryFullName))] } },
    select: { id: true, fullName: true },
  });
  const repositoryIdByName = new Map(repositories.map((repo) => [repo.fullName, repo.id]));

  const targets = paused.flatMap((run) => {
    const repositoryId = repositoryIdByName.get(run.repositoryFullName);
    // Issueのキャッシュを引けないだけかもしれないので、消えている＝closeとは読まない
    return repositoryId === undefined ? [] : [{ run, repositoryId }];
  });
  if (targets.length === 0) return runs;

  const closed = await db.issue.findMany({
    where: {
      state: "CLOSED",
      OR: targets.map(({ run, repositoryId }) => ({ repositoryId, number: run.issueNumber })),
    },
    select: { repositoryId: true, number: true },
  });
  const closedKeys = new Set(closed.map((issue) => `${issue.repositoryId}#${issue.number}`));

  const stoppedIds = new Set(
    targets
      .filter(({ run, repositoryId }) => closedKeys.has(`${repositoryId}#${run.issueNumber}`))
      .map(({ run }) => run.id),
  );
  if (stoppedIds.size === 0) return runs;

  await db.manualStepRun.updateMany({
    where: { id: { in: [...stoppedIds] } },
    data: {
      status: "STOPPED",
      pausedReason: null,
      message: CLOSED_ISSUE_STOP_MESSAGE,
      finishedAt: now,
    },
  });

  return runs.map((run) =>
    stoppedIds.has(run.id)
      ? {
          ...run,
          status: "STOPPED" as const,
          pausedReason: null,
          message: CLOSED_ISSUE_STOP_MESSAGE,
          finishedAt: now,
        }
      : run,
  );
}

/**
 * 実行を1歩進める。**進める条件と止める条件はここ1か所にまとめる**（報告からも画面からも
 * 同じ関数を通す）。止まる条件は#1869から変えていない。
 *
 * - 代行できない項目に来た（人が実行して「実行した・次へ」を押すと続きから流れる）
 * - 実行が失敗した（原因と修正案を見て、直してから続ける）
 * - 積めなかった（起動先が居ない・本文が変わった等。理由は`message`に入る）
 */
async function syncManualStepRun(run: ManualStepRun, now: Date): Promise<ManualStepRun> {
  if (run.status !== "RUNNING") return run;

  const context = await loadRunContext(run, now);
  if (!context) {
    return pauseRun(run, "ENQUEUE_FAILED", "手作業Issueの本文を読めなかったため止まりました。");
  }

  let current = run;
  if (current.currentJobId !== null) {
    const settled = await settleCurrentJob(current, context.plan);
    // まだ走っている／既に止めた（`settled`がnull）ならここで終わり
    if (settled === null) return current;
    current = settled;
    if (current.status !== "RUNNING") return current;
  }

  // **画面から直接積まれた1件を拾う。** 失敗した手順を「もう一度実行」した・修正案を適用した
  // ときは画面が既存の経路（`POST /api/dispatch`）で積む。`activeKey`はIssue単位なので二重には
  // ならないが、拾わずに次を積もうとすると`already_queued`で止まってしまう
  const adopted = await adoptActiveJob(current);
  if (adopted !== null) return adopted;

  const doneLines = await skipAlreadySucceeded(current, context.plan, now);
  const next = findNextManualStepEntry(context.plan, doneLines);
  if (next === null) {
    return db.manualStepRun.update({
      where: { id: current.id },
      data: { status: "FINISHED", pausedReason: null, message: null, finishedAt: now },
    });
  }

  if (next.rejection !== null || next.command === null) {
    const reason = next.rejection === null ? "no_command" : next.rejection;
    const message = describeManualStepExecutionRejection(reason, {
      hostName: current.targetHost,
      // **止まった項目のデバイス**（#2052）。Issue単位の既定値を出すと、ブラウザの手順で
      // 止まったのに「サブPCで実行するため」と表示される
      device: next.device,
      interactiveCommand: next.interactiveCommand,
      placeholder: next.placeholder,
    });
    // **`## 完了の確認方法`のコマンドにはチェックが無い**（#1869）。人が実行するしかない確認で
    // 止まった場合、流し終えた扱いにしておかないと、続きへ進めても同じ項目でまた止まる（#2025）。
    // 手順はチェックが付いた時点で計画から外れるので、ここで記録するのは確認だけ
    const doneLines =
      next.kind === "verification" && pauseReasonFor(reason) === "USER"
        ? appendDoneLine(current.doneLines, next.line)
        : current.doneLines;
    return pauseRun(current, pauseReasonFor(reason), message, doneLines);
  }

  const enqueued = await enqueueManualStepJob({
    repositoryFullName: current.repositoryFullName,
    issueNumber: current.issueNumber,
    hostName: current.targetHost,
    stepLine: next.line,
    approvedCommand: next.command,
    requestedByUserId: current.startedByUserId,
    now,
  });
  if (!enqueued.ok) {
    // **既に積まれている＝別の経路が同じ1件を積んだ**（報告と画面の読み取りが同時に来た場合）。
    // 止めずにそのまま走らせる（`activeKey`のunique制約が二重投入を防いでいる）
    if (enqueued.rejection === "already_queued") return current;
    return pauseRun(current, pauseReasonFor(enqueued.rejection), enqueued.message);
  }

  return db.manualStepRun.update({
    where: { id: current.id },
    data: { currentJobId: enqueued.job.id, message: null },
  });
}

/**
 * 画面から直接積まれた代行実行を、この実行の1件として引き受ける（#1882）。
 *
 * 失敗した手順の「もう一度実行」・修正案の「適用して実行」は、**既存の経路**
 * （`POST /api/dispatch` → `enqueueManualStepJob`）で積まれる。実行の入口を増やさない代わりに、
 * 走り出した1件をこちらが見失わないようにする。
 *
 * @returns 引き受けたら更新後の実行、対象が無ければ`null`
 */
async function adoptActiveJob(run: ManualStepRun): Promise<ManualStepRun | null> {
  const active = await db.dispatchJob.findFirst({
    where: {
      repositoryFullName: run.repositoryFullName,
      issueNumber: run.issueNumber,
      kind: "MANUAL_STEP",
      status: { in: ["QUEUED", "CLAIMED", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!active) return null;
  return db.manualStepRun.update({
    where: { id: run.id },
    data: { currentJobId: active.id, message: null },
  });
}

/**
 * **この実行の中で既に成功している項目は、もう一度実行しない**（#1882）。
 *
 * 止まっている間に人が手元で実行して「実行した・次へ」を押した場合はチェックが付くので
 * `plan`側で除かれるが、確認コマンド（チェックが無い）や、画面から直接積み直して成功した
 * 1件は`doneLines`に載っていないことがある。**同じコマンドを二度流す方が危険**なので、
 * この実行の開始以降に成功しているジョブがある行は流し終えた扱いにする。
 */
async function skipAlreadySucceeded(
  run: ManualStepRun,
  plan: ManualStepRunPlan,
  now: Date,
): Promise<Set<number>> {
  const doneLines = parseDoneLines(run.doneLines);
  const pending = plan.entries.filter(
    (entry) => !entry.checked && !doneLines.has(entry.line),
  );
  if (pending.length === 0) return doneLines;

  const succeeded = await db.dispatchJob.findMany({
    where: {
      repositoryFullName: run.repositoryFullName,
      issueNumber: run.issueNumber,
      kind: "MANUAL_STEP",
      status: "SUCCEEDED",
      exitCode: 0,
      manualStepLine: { in: pending.map((entry) => entry.line) },
      finishedAt: { gte: run.startedAt },
    },
    select: { manualStepLine: true },
  });
  if (succeeded.length === 0) return doneLines;

  for (const job of succeeded) {
    if (job.manualStepLine !== null) doneLines.add(job.manualStepLine);
  }
  await db.manualStepRun.update({
    where: { id: run.id },
    data: { doneLines: JSON.stringify([...doneLines]), updatedAt: now },
  });

  // 手順にはチェックを付ける（付いていなければ）。確認コマンドには何も書き換えない
  for (const entry of pending) {
    if (!doneLines.has(entry.line) || entry.kind !== "step" || entry.checked) continue;
    await checkManualStepLine(run.repositoryFullName, run.issueNumber, entry.line);
  }
  return doneLines;
}

/**
 * 積んである1件の決着をつける。
 *
 * @returns まだ走っている場合は`null`。終わっていれば次へ進める状態にした実行を返す
 *   （失敗していれば`PAUSED`にしたもの）。
 */
async function settleCurrentJob(
  run: ManualStepRun,
  plan: ManualStepRunPlan,
): Promise<ManualStepRun | null> {
  const jobId = run.currentJobId;
  if (jobId === null) return run;

  const job = await db.dispatchJob.findUnique({ where: { id: jobId } });
  // ジョブが消えている（保持期間外の掃除など）＝結果を確かめられない。積み直せるようにする
  if (!job) {
    return db.manualStepRun.update({ where: { id: run.id }, data: { currentJobId: null } });
  }
  if (isActiveDispatchJobStatus(job.status)) return null;

  const line = job.manualStepLine;
  if (job.status === "SUCCEEDED" && job.exitCode === 0 && line !== null) {
    // **同じ結果を二重に処理しない。** 報告と画面の読み取りが同時に来ても、
    // `currentJobId`を条件にした更新で片方だけが通る
    const claimed = await db.manualStepRun.updateMany({
      where: { id: run.id, currentJobId: jobId },
      data: { currentJobId: null, doneLines: appendDoneLine(run.doneLines, line) },
    });
    if (claimed.count === 0) return null;

    const entry = findManualStepEntry(plan, line);
    // 手順にはチェックを付ける（確認コマンドにはチェックが無い。#1869）
    if (entry !== null && entry.kind === "step" && !entry.checked) {
      await checkManualStepLine(run.repositoryFullName, run.issueNumber, line);
    }
    return db.manualStepRun.findUniqueOrThrow({ where: { id: run.id } });
  }

  return pauseRun(run, "FAILED", describeFailedJob(job.status, job.exitCode, job.message));
}

function describeFailedJob(
  status: string,
  exitCode: number | null,
  message: string | null,
): string {
  if (status === "CANCELED") return message ?? "実行を取り消したため止まりました。";
  if (status === "TIMEOUT") return message ?? "実行が時間切れになったため止まりました。";
  if (status === "SKIPPED") return message ?? "実行を見送ったため止まりました。";
  if (exitCode !== null) return `終了コード ${exitCode} で終わったため止まりました。`;
  return message ?? "実行が失敗したため止まりました。";
}

/** 止める理由の対応。**ホスト側の事情と、人が実行する必要とを混ぜない**（次に押すものが違う） */
function pauseReasonFor(rejection: ManualStepExecutionRejection): "USER" | "ENQUEUE_FAILED" {
  switch (rejection) {
    case "no_command":
    case "device_not_subpc":
    case "not_manual_step":
    // 対話が要るコマンド（#2025）。**人が実行するしかない**ので、ホスト側の事情と混ぜない
    case "interactive_command":
    // プレースホルダを含むコマンド（#2051）。人が値を埋めてから実行するしかない
    case "placeholder_command":
      return "USER";
    default:
      return "ENQUEUE_FAILED";
  }
}

async function pauseRun(
  run: ManualStepRun,
  reason: "USER" | "FAILED" | "ENQUEUE_FAILED",
  message: string | null,
  doneLines: string = run.doneLines,
): Promise<ManualStepRun> {
  return db.manualStepRun.update({
    where: { id: run.id },
    data: {
      status: "PAUSED",
      pausedReason: reason,
      message,
      currentJobId: run.currentJobId,
      doneLines,
    },
  });
}

/**
 * 中断のときに、走っている1件を止める。**戻り値はそのまま画面に出す一文。**
 *
 * 止められたかどうかで押した人がやることが変わる（待つのか、打ち切りを待つのか）ため、
 * 「中断しました」だけで終わらせない。
 */
async function stopCurrentJob(
  run: ManualStepRun,
  userId: string | null,
  now: Date,
): Promise<string> {
  if (run.currentJobId === null) return "自動実行を中断しました。";

  const job = await db.dispatchJob.findUnique({ where: { id: run.currentJobId } });
  if (!job || !isActiveDispatchJobStatus(job.status)) {
    return "自動実行を中断しました（走っているコマンドはありません）。";
  }

  // まだ走り出していない（順番待ち・払い出し済み）＝取り消せば実行されない
  if (job.status === "QUEUED" || job.status === "CLAIMED") {
    const canceled = await cancelDispatchJob({ jobId: job.id, now });
    return canceled.ok
      ? "自動実行を中断しました（積んでいたコマンドは取り消しました）。"
      : "自動実行を中断しました（積んでいたコマンドは既に動き出していました）。";
  }

  const aborted = await enqueueManualStepAbortJob({
    repositoryFullName: run.repositoryFullName,
    issueNumber: run.issueNumber,
    hostName: run.targetHost,
    targetJobId: job.id,
    requestedByUserId: userId,
    now,
  });
  if (aborted.ok) {
    return `自動実行を中断しました（${run.targetHost}で走っているコマンドの停止を送りました。届くまで数秒〜30秒かかります）。`;
  }
  return `自動実行を中断しました。ただし${aborted.message}`;
}

/** 手順にチェックを付ける（GitHub App名義。自動実行中は押した人がその場に居ない） */
async function checkManualStepLine(
  repositoryFullName: string,
  issueNumber: number,
  line: number,
): Promise<void> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return;

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: issueNumber },
    select: { body: true },
  });
  if (!issue) return;

  const nextBody = toggleTaskListLine(issue.body ?? "", line, true);
  // 指定行がタスク行でない＝本文が変わっている。**無関係な行を壊さない**（画面と同じ判定）
  if (nextBody === (issue.body ?? "")) return;

  const token = await resolveInstallationToken(repositoryFullName);
  if (token === null) return;

  const [owner, repo] = repositoryFullName.split("/");
  try {
    const updated = await updateIssue(owner, repo, issueNumber, token, { body: nextBody });
    await upsertIssueAndGetDisplay(repository, updated);
  } catch (error) {
    // **チェックが付かなくても実行は続ける。** 実行そのものは終わっているので、ここで
    // 止めると「実行済みなのに次へ進めない」状態になる（付け直しは画面からできる）
    console.error(`[manual-step-run] チェックを付けられませんでした ${repositoryFullName}#${issueNumber}:`, error);
  }
}

type RunContext = {
  plan: ManualStepRunPlan;
  issueTitle: string | null;
  issueId: string | null;
};

/** 実行計画の材料（本文・ラベル・ホストの申告）をDBのキャッシュから集める */
async function loadRunContext(run: ManualStepRun, now: Date): Promise<RunContext | null> {
  const repository = await db.repository.findFirst({
    where: { fullName: run.repositoryFullName },
    select: { id: true },
  });
  if (!repository) return null;

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: run.issueNumber },
    select: { body: true, title: true, githubIssueId: true, labels: { select: { name: true } } },
  });
  if (!issue) return null;

  const host = await db.dispatchHost.findUnique({ where: { name: run.targetHost } });
  const { parseManualStepGuide } = await import("@/lib/manual-step-guide");
  const guide = parseManualStepGuide(issue.body);

  return {
    plan: buildManualStepRunPlan(issue.body, guide, {
      host: host
        ? {
            online: isDispatchHostOnline(host.lastSeenAt, now),
            manualStepCapable: host.manualStepCapable,
            manualStepValuesCapable: host.manualStepValuesCapable,
          }
        : null,
      isManualStepIssue: issue.labels.some((label) => label.name === MANUAL_STEP_LABEL),
    }),
    issueTitle: issue.title,
    issueId: String(issue.githubIssueId),
  };
}

async function toRunView(run: ManualStepRun, now: Date): Promise<ManualStepRunView> {
  const context = await loadRunContext(run, now);
  const doneLines = parseDoneLines(run.doneLines);
  const entries = context?.plan.entries ?? [];
  const done = entries.filter((entry) => entry.checked || doneLines.has(entry.line)).length;
  const current: ManualStepRunEntry | null =
    context === null ? null : findNextManualStepEntry(context.plan, doneLines);

  return {
    repositoryFullName: run.repositoryFullName,
    issueNumber: run.issueNumber,
    issueTitle: context?.issueTitle ?? null,
    issueId: context?.issueId ?? null,
    targetHost: run.targetHost,
    status: run.status,
    pausedReason: run.pausedReason,
    done,
    total: entries.length,
    currentLine: current?.line ?? null,
    currentLabel: current?.text ?? null,
    currentJobId: run.currentJobId,
    message: run.message,
    diagnoseConsent: run.diagnoseConsent,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

async function findRun(
  repositoryFullName: string,
  issueNumber: number,
): Promise<ManualStepRun | null> {
  return db.manualStepRun.findUnique({
    where: { repositoryFullName_issueNumber: { repositoryFullName, issueNumber } },
  });
}

/** 流し終えた行のJSON配列を読む。**壊れていれば空**（読めない記録で実行を止めない） */
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

/** 打ち切りまでの分数（画面の文言に使う） */
export const MANUAL_STEP_TIMEOUT_MINUTES = MANUAL_STEP_TIMEOUT_SECONDS / 60;
