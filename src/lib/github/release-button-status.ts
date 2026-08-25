import type { ReleaseStatus } from "@/hooks/use-release-status";
import type { CiState } from "@/lib/github/release-api";
import { isMergeJudgementPending } from "@/lib/pull-request-list";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

/**
 * ヘッダーの常時表示アイコン向けの4値サマリ。
 * "idle": 対象なし、または前回のデプロイが成功して静止している状態
 * "progressing": 自動で進行中（人の操作は不要）
 * "action_required": 人の操作（マージ等）が必要
 * "error": デプロイ失敗
 */
export type ReleaseButtonStatus = "idle" | "progressing" | "action_required" | "error";

/** リリースworkflow・本番デプロイworkflowの実行。判定に使う2つのフィールドだけを見る */
type WorkflowRunState = { status: string; conclusion: string | null };

/**
 * マージ待ちPRのうち、「人が押す番か」の判定に使う状態だけ（#2326）。
 *
 * `MergeJudgement`をそのまま受け取らず真偽値にしているのは、この判定が
 * `claude-review-develop.yml`のcheck-runの形に依存しないようにするため。
 * 判定の中身を読むのは`isMergeJudgementPending`（`lib/pull-request-list.ts`）の役目。
 */
type PendingMergePullRequestState = {
  ciState: CiState | null;
  /** 自動マージ可否の判定（`claude-review-develop.yml`）がまだ走っているか（#1968・#2326） */
  mergeJudgementPending: boolean;
};

/**
 * 4値サマリの判定に必要な最小の入力。`ReleaseStatus`（＝`/api/repositories/release`の戻り値）
 * を組み立てずに判定できるよう、リポジトリ横断で状態を返す
 * `/api/repositories/release-pending-merges`からも同じ判定を通せる形にしている（#1117）。
 */
export type ReleaseStatusSummaryInput = {
  /** `release-develop-to-main.yml`の最新実行 */
  workflowRun: WorkflowRunState | null;
  /** mainブランチ上の`deploy.yml`の最新実行 */
  deployWorkflowRun: WorkflowRunState | null;
  /** developへのマージ待ちバンプPR。オープン中でなければnull */
  bumpPullRequest: PendingMergePullRequestState | null;
  /** mainへのマージ待ちdevelop→mainのPR。オープン中でなければnull */
  releasePullRequest: PendingMergePullRequestState | null;
  /** developだけbump済みでdevelop→mainのPRが未作成の過渡状態か */
  releasePending: boolean;
};

function hasFailed(run: WorkflowRunState | null): boolean {
  return run != null && run.status === "completed" && run.conclusion !== "success";
}

function isRunning(run: WorkflowRunState | null): boolean {
  return run != null && run.status !== "completed";
}

/**
 * サマリが`error`になる原因がどちらの実行かを返す。`error`でなければnull。
 * 一覧のバッジで「デプロイ失敗」と「リリース失敗」を書き分けるのに使う（#1117）。
 * 優先順位は`summarizeReleaseStatus`の判定順と同じ（本番デプロイを先に見る）。
 */
export function resolveFailedReleaseWorkflow(
  input: ReleaseStatusSummaryInput,
): "deploy" | "release" | null {
  if (hasFailed(input.deployWorkflowRun)) return "deploy";
  if (hasFailed(input.workflowRun)) return "release";
  return null;
}

/**
 * リリースの状態を4値サマリへ畳む（#542）。`release-progress.tsx`の`buildSteps`とは意図的に
 * 判定ロジックを分離しているが、マージ待ちPRの「要操作」判定基準（CIが`pending`でなくなった
 * 時点）だけは揃えている。develop→main PRのマージ待ちのみを主対象としつつ、CI通過後もbump PRが
 * 残り続けるauto-merge滞留も「要操作」に含める（#542でのフィードバックを反映）。
 * `workflowRun`（`release-develop-to-main.yml`自体の最新実行）が失敗している場合も、
 * `deployWorkflowRun`と同じ優先度で`error`とする（#727）。
 *
 * **CIが実行中の間は、develop→main PRがオープンでも「要操作」にしない**（#1433）。PRが作られた
 * 直後はまだマージできず、押しても弾かれる操作を強調して促すことになるため。元はbump PRだけが
 * この基準を持っていたが、develop→main PRも同じ基準に揃えた。`unknown`（`Checks: read`が無い・
 * check-runsが0件・取得失敗）は「要操作」のまま残す。CI状態が取れないだけでマージの導線が
 * 消えてしまわないようにするため。
 *
 * **自動マージ可否の判定（`claude-review-develop`）が走っている間も「要操作」にしない**
 * （#2326）。判定のcheck-runはCI状態の集約から外してある（#1799）ため、Claudeのレビュー中でも
 * `ciState`は`success`になり、CIだけを基準にすると琥珀の「mainへマージ待ち」が出ていた。
 * その窓のあいだ画面のマージボタンは「判定中」で無効（#1968）で、押せる操作は無い。
 * ブランチ画面（`resolveReleaseMergeTarget`）・通知ベル・PR一覧（#2283）と同じ基準。
 */
export function summarizeReleaseStatus(input: ReleaseStatusSummaryInput): ReleaseButtonStatus {
  const { workflowRun, deployWorkflowRun, bumpPullRequest, releasePullRequest, releasePending } =
    input;

  if (resolveFailedReleaseWorkflow(input)) return "error";

  if (isWaitingUserMerge(releasePullRequest)) return "action_required";
  if (isWaitingUserMerge(bumpPullRequest)) return "action_required";

  if (isRunning(workflowRun)) return "progressing";
  if (isRunning(deployWorkflowRun)) return "progressing";
  if (releasePullRequest) return "progressing";
  if (bumpPullRequest) return "progressing";
  if (releasePending) return "progressing";

  return "idle";
}

/**
 * マージ待ちPRが「人が押す番」で止まっているか（#1433・#2326）。
 * CIが実行中でも、自動マージ可否の判定中でもない＝いま押せば進む状態。
 */
function isWaitingUserMerge(pullRequest: PendingMergePullRequestState | null): boolean {
  if (pullRequest === null) return false;
  return pullRequest.ciState !== "pending" && !pullRequest.mergeJudgementPending;
}

/**
 * `AvailableReleaseStatus`からヘッダーのRocketボタン表示用の状態サマリを算出する（#542）。
 * `phase`はバンプPRをdevelop→mainのPRより優先して決まるため、その優先順位を保ったまま
 * `summarizeReleaseStatus`の入力へ移し替える。
 */
export function summarizeReleaseButtonStatus(status: AvailableReleaseStatus): ReleaseButtonStatus {
  return summarizeReleaseStatus({
    workflowRun: status.workflowRun,
    deployWorkflowRun: status.deployWorkflowRun,
    bumpPullRequest:
      status.phase === "bump_pr_open" && status.bumpPullRequest
        ? {
            ciState: status.bumpPullRequest.ciState,
            mergeJudgementPending: isMergeJudgementPending(status.bumpPullRequest.mergeJudgement),
          }
        : null,
    releasePullRequest:
      status.phase === "release_pr_open" && status.releasePullRequest
        ? {
            ciState: status.releasePullRequest.ciState,
            mergeJudgementPending: isMergeJudgementPending(
              status.releasePullRequest.mergeJudgement,
            ),
          }
        : null,
    releasePending: status.phase === "release_pending",
  });
}

/** マージ待ちPRのマージ先。"main": develop→mainのPR、"develop": バンプPR（#979） */
export type ReleaseMergeTarget = "main" | "develop";

/**
 * マージ待ちの文言。**マージ待ちを出す画面はここだけを通す**（#2038）。
 *
 * ヘッダーのリリース状況・スマホのリポジトリ一覧（`describeReleaseStatusBadge`）に加えて、
 * ブランチ画面の畳んだ1行と展開したリリースの見出しも同じ文言を出すため、リテラルを
 * 写さずここへ寄せる。マージ先が分からない場合だけ「マージ待ち」に落とす。
 */
export function releaseMergeTargetLabel(target: ReleaseMergeTarget | null): string {
  if (target === "develop") return "developへマージ待ち";
  if (target === "main") return "mainへマージ待ち";
  return "マージ待ち";
}

/** バッジの見た目。呼び出し側で配色に対応付ける */
export type ReleaseStatusBadgeTone = "progressing" | "action" | "error";

export type ReleaseStatusBadge = { label: string; tone: ReleaseStatusBadgeTone };

/**
 * リリース状況を一覧のバッジ1つ（文言＋トーン）へ畳む（#1117）。
 * モバイルのリポジトリ一覧とPCヘッダーのポップオーバーが同じ文言を出すよう、表示側では
 * 分岐を持たずこの関数だけを通す。`idle`は何も出さない（静止している状態にバッジを出すと
 * 一覧が常時埋まってしまい、動いているものが目立たなくなるため）。
 */
export function describeReleaseStatusBadge(input: {
  status: ReleaseButtonStatus;
  /** `error`のとき、どちらの実行が失敗しているか */
  failedWorkflow: "deploy" | "release" | null;
  /** マージ待ちPRのマージ先。マージ待ちでなければnull */
  mergeTarget: ReleaseMergeTarget | null;
  /** マージ待ちPRのCI状態。マージ待ちでなければnull */
  ciState: CiState | null;
}): ReleaseStatusBadge | null {
  const { status, failedWorkflow, mergeTarget, ciState } = input;

  if (status === "idle") return null;

  // マージできない状態にあること自体を優先して出す。「マージすればよい」と「チェックが
  // 落ちていて直す必要がある」を取り違えさせないため（#1059）。
  if (ciState === "failure") return { label: "チェック失敗", tone: "error" };

  if (status === "error") {
    return { label: failedWorkflow === "deploy" ? "デプロイ失敗" : "リリース失敗", tone: "error" };
  }

  if (status === "action_required") {
    return { label: releaseMergeTargetLabel(mergeTarget), tone: "action" };
  }

  return { label: "実施中", tone: "progressing" };
}

/**
 * リリース一覧での並び順の優先度を返す（#1495）。**小さいほど上に出す。**
 * リポジトリ名順のまま並べると、人の操作を待っているものが一覧の途中に埋もれて
 * 「開いてから探す」必要があるため、`describeReleaseStatusBadge`のトーンと同じ順序
 * （error → action → progressing → バッジ無し）で手前へ寄せる。
 *
 * 失敗（`error`・CI失敗）はマージ待ちと同じく人の対応が要るうえ、より強い通知として
 * 既にヘッダーのドットの色を変えている（#1059）ため、マージ待ちより上に置く。
 * 同順位のものは呼び出し側で安定ソートし、元の並び（リポジトリ名順）を保つ。
 */
export function releaseAttentionRank(input: {
  /** リポジトリのリリース状態。未取得ならnull（＝静止扱い） */
  status: ReleaseButtonStatus | null;
  /** マージ待ちPRのCI状態。マージ待ちでなければnull */
  ciState: CiState | null;
}): number {
  const { status, ciState } = input;

  if (status == null || status === "idle") return 3;
  if (ciState === "failure" || status === "error") return 0;
  if (status === "action_required") return 1;
  return 2;
}
