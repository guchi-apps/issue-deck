import {
  isSessionLaunchJobKind,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";

/**
 * Issue一覧の行に出す「実行が始まる前」の状態（#2449）。
 *
 * サブPCへ積んだ直後のIssueは進捗Statusが`Ready`のままで、右上の円グラフ
 * （`WorkflowStepBadge`）は`getWorkflowStepIndex`がnullを返して何も描かない。**押した後も
 * 行の見た目が押す前とまったく同じ**で、積めたのか・何番目で待っているのかを読む場所が
 * 一覧に無かった（振り分けだけは#1347で「実行中」ビューへ移している）。
 *
 * 材料は`GET /api/dispatch`が既に返しているジョブだけで、DBもAPIも増やさない。
 *
 * **並びは払い出し（`claimDispatchJobs`）・実行キュー（`summarizeDispatchQueue`）と同じ**
 * ——`queuePriority`の降順 → `createdAt`の昇順。見えている順番と走る順番を一致させるための
 * 決まりで、ここだけ別の並びにすると「先頭へ上げる」（#1541）を押した結果が一覧に映らない。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる（`dispatch-job.ts`と
 * 同じ扱い。`jobs.ts`はできない）。
 */

/**
 * 実行が始まる前の段階。
 *
 * - `queued` … まだ誰も取りに来ていない（`QUEUED`）
 * - `starting` … ホストが受け取ってセッションを立てている最中（`CLAIMED`・`RUNNING`）
 *
 * **`SUCCEEDED`は含めない。** 起動ジョブはtmuxセッションが立った時点で成功として終わるため、
 * そこから先は「実行中」であって待ちではない（セッションの表示と進捗Statusが引き受ける）。
 */
export type IssueQueuePhase = "queued" | "starting";

export type IssueQueueState = {
  phase: IssueQueuePhase;
  /**
   * 順番待ちの中で何番目か（1始まり）。`starting`のときはnull。
   *
   * **数えるのは`QUEUED`のジョブだけ**で、走っているものは番号を持たない。
   */
  position: number | null;
  /** 順番待ちの総数（`position`の分母）。`queued`の件数 */
  queuedTotal: number;
  /** そのIssueのジョブ。待っている理由（`describeDispatchJobWaitReason`）を引くのに使う */
  job: DispatchJobView;
};

/** `repositoryFullName#issueNumber`。Issue側の`id`を持たないジョブと突き合わせるための鍵 */
function issueKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

/**
 * ジョブ一覧からIssueごとの待ち状態を組む。鍵は`repositoryFullName#issueNumber`。
 *
 * **同じIssueに未完了のジョブが2件あることは無い**（`DispatchJob.activeKey`が
 * `owner/repo#番号`のunique列）。それでも念のため、先に見つかった＝走る順で早い方を採る。
 */
export function buildIssueQueueStates(
  jobs: readonly DispatchJobView[],
): Map<string, IssueQueueState> {
  // セッションの枠を使う種別だけを見る（`SESSION_LAUNCH_JOB_KINDS`）。停止・追加指示などの
  // 制御ジョブは枠外で先に流れるもので、「順番待ち」として数えると実行キューと食い違う
  const launchJobs = jobs.filter((job) => isSessionLaunchJobKind(job.kind));
  const byRunOrder = [...launchJobs].sort(
    (a, b) => b.queuePriority - a.queuePriority || a.createdAt.localeCompare(b.createdAt),
  );

  const queued = byRunOrder.filter((job) => job.status === "QUEUED");
  const states = new Map<string, IssueQueueState>();

  for (const [index, job] of queued.entries()) {
    const key = issueKey(job.repositoryFullName, job.issueNumber);
    if (states.has(key)) continue;
    states.set(key, {
      phase: "queued",
      position: index + 1,
      queuedTotal: queued.length,
      job,
    });
  }

  for (const job of byRunOrder) {
    if (job.status !== "CLAIMED" && job.status !== "RUNNING") continue;
    const key = issueKey(job.repositoryFullName, job.issueNumber);
    if (states.has(key)) continue;
    states.set(key, { phase: "starting", position: null, queuedTotal: queued.length, job });
  }

  return states;
}

/** そのIssueの待ち状態を引く。無ければnull */
export function findIssueQueueState(
  states: ReadonlyMap<string, IssueQueueState>,
  repositoryFullName: string,
  issueNumber: number,
): IssueQueueState | null {
  return states.get(issueKey(repositoryFullName, issueNumber)) ?? null;
}

/**
 * 行に添える短い文言。
 *
 * **順番待ちは番号まで出す。** 「順番待ち」だけでは、あと何本先かが分からず、待つのか
 * 先頭へ上げるのかを決められない（実行キューを開けば分かるが、そこまで開かせない）。
 * 1件しか待っていないときは番号を出さない（「1番目」と書いても分母が無く、情報が増えない）。
 */
export function describeIssueQueueState(state: IssueQueueState): string {
  if (state.phase === "starting") return "起動中";
  if (state.position === null || state.queuedTotal <= 1) return "順番待ち";
  return `順番待ち ${state.position}番目`;
}
