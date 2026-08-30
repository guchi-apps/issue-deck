import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchQueueSummary } from "@/lib/dispatch/queue-summary";

/**
 * Issue一覧の行に出す「実行が始まる前」の状態（#2449）。
 *
 * サブPCへ積んだ直後のIssueは進捗Statusが`Ready`のままで、右上の進捗バー
 * （`WorkflowStepBadge`）は`getWorkflowStepIndex`がnullを返して何も描かない。**押した後も
 * 行の見た目が押す前とまったく同じ**で、積めたのか・何番目で待っているのかを読む場所が
 * 一覧に無かった（振り分けだけは#1347で「実行中」ビューへ移している）。
 *
 * 材料は`GET /api/dispatch`が既に返しているジョブだけで、DBもAPIも増やさない。
 *
 * **並べ替えはしない。** 受け取るのは`summarizeDispatchQueue`が並べ終えた要約
 * （`queuePriority`の降順 → `createdAt`の昇順。払い出し`claimDispatchJobs`と同じ規則）で、
 * ここで並べ直すと同じ規則が3か所目になり、片方が緩んだときに実行キューのポップオーバーと
 * 一覧の番号が同じ画面で食い違う。
 *
 * **番号はホストごとに数える。** 払い出しは`targetHost`で絞ってから並べるため
 * （`jobs.ts`の`claimDispatchJobs`）、全ホストを通しで数えると別ホスト宛てのジョブまで
 * 番号に混ざる。（そのホストが取りに来ない種別まで絞る能力フラグまでは見ない——申告は
 * pollerの都合で変わるもので、番号のためにそこまで写すと二重管理になる。）
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
   * そのホストの順番待ちの中で何番目か（1始まり）。`starting`のときはnull。
   *
   * **数えるのは`QUEUED`のジョブだけ**で、走っているものは番号を持たない。
   */
  position: number | null;
  /** そのホストの順番待ちの件数（`position`の分母） */
  queuedTotal: number;
  /** そのIssueのジョブ。待っている理由（`describeDispatchJobWaitReason`）を引くのに使う */
  job: DispatchJobView;
};

/** `repositoryFullName#issueNumber`。Issue側の`id`を持たないジョブと突き合わせるための鍵 */
function issueKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

/**
 * 実行キューの要約からIssueごとの待ち状態を組む。鍵は`repositoryFullName#issueNumber`。
 *
 * **同じIssueに未完了のジョブが2件あることは無い**（`DispatchJob.activeKey`が
 * `owner/repo#番号`のunique列）。それでも念のため、走る順で早い方を採る。
 */
export function buildIssueQueueStates(
  summary: Pick<DispatchQueueSummary, "queued" | "running">,
): Map<string, IssueQueueState> {
  const states = new Map<string, IssueQueueState>();

  // ホストごとの順番待ちの本数。番号の分母になる
  const queuedTotalByHost = new Map<string, number>();
  for (const job of summary.queued) {
    queuedTotalByHost.set(job.targetHost, (queuedTotalByHost.get(job.targetHost) ?? 0) + 1);
  }

  const positionByHost = new Map<string, number>();
  for (const job of summary.queued) {
    const position = (positionByHost.get(job.targetHost) ?? 0) + 1;
    positionByHost.set(job.targetHost, position);
    const key = issueKey(job.repositoryFullName, job.issueNumber);
    if (states.has(key)) continue;
    states.set(key, {
      phase: "queued",
      position,
      queuedTotal: queuedTotalByHost.get(job.targetHost) ?? 0,
      job,
    });
  }

  for (const job of summary.running) {
    const key = issueKey(job.repositoryFullName, job.issueNumber);
    if (states.has(key)) continue;
    states.set(key, {
      phase: "starting",
      position: null,
      queuedTotal: queuedTotalByHost.get(job.targetHost) ?? 0,
      job,
    });
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
