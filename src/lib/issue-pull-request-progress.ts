import type { AiReviewState, MergeJudgement } from "@/lib/github/check-rollup";
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import type { CiState } from "@/lib/github/release-api";
import { type ProgressStatusKey } from "@/lib/issue-progress";
import {
  AI_REVIEW_SETTLED_LABEL,
  AI_REVIEW_SHORT_LABEL,
  CI_STATE_LABEL,
  MERGE_JUDGEMENT_STEP_LABEL,
  mergeJudgementLabel,
} from "@/lib/pull-request-list";

/**
 * 「developへマージ」段の中で、いま何が終わっていて何を待っているか（#2816）。
 *
 * 進捗ステップの`Develop PR`は、PRを作った瞬間からマージされるまで同じ表示のままだった。
 * 実際にその間に動いているのは**PRの作成（＝実装完了）→ CI → Claudeのレビュー → マージ**の
 * 4つで、待っている人が知りたいのは「どれで止まっているか」。材料
 * （`ciState`・`mergeJudgement`・`aiReview`）はPR画面が既に取っているものをそのまま使い、
 * **GitHub APIは1回も増やさない。**
 *
 * 文言も新しく作らず、PR画面のもの（`mergeJudgementLabel`・`CI_STATE_LABEL`・
 * `AI_REVIEW_SETTLED_LABEL`と同じ言い方）に揃える。同じ状態が画面によって違う名前で出ると、
 * どちらが新しいのかを読む側が判断できなくなる（#2150で一度そうなっている）。
 */

/** 内訳の段。`opened`（実装完了）だけはPRが在ること自体が根拠なので常に済み */
export type IssuePullRequestStepKey = "opened" | "ci" | "ai-review" | "merge";

/**
 * 段の状態。`failed`は「その段で止まっている」で、`pending`は「まだそこまで来ていない」。
 * 通り過ぎた段は`done`で、材料が無くて言えない段は並べない（段ごと落とす）。
 */
export type IssuePullRequestStepState = "done" | "current" | "pending" | "failed";

export type IssuePullRequestStep = {
  key: IssuePullRequestStepKey;
  label: string;
  /**
   * 幅の狭い場所（PR一覧のステータスレール。#2942）に出す短い言い回し。短くする必要が無い段では
   * `label`と同じ文字列を入れる。
   *
   * **新しい言葉を作らず、`label`から主語（「Claudeの」）を落としただけにする。**
   * `REPAIR_KIND_RUNNING_SHORT_LABEL`と同じ扱いで、長い方を`title`に出せば全文も読める。
   * 列そのものに「Claudeのレビュー」と見出しが付くため、短い方でも何の話かは失われない。
   */
  shortLabel: string;
  state: IssuePullRequestStepState;
};

/**
 * 待っているものの重さ。色の出し分けに使う。
 *
 * - `running` … 機械が動いている（放っておけば進む）
 * - `waiting` … 人が動かないと進まない（マージ待ち）
 * - `attention` … 止まっている（CI失敗・レビュー失敗・コンフリクト）
 */
export type IssuePullRequestProgressTone = "running" | "waiting" | "attention";

export type IssuePullRequestProgress = {
  /** 対応PRの番号。詳細の見出しに出す */
  pullRequestNumber: number;
  /** 一覧の添える字・詳細の見出しに出す「いま何を待っているか」の1語 */
  label: string;
  tone: IssuePullRequestProgressTone;
  /** 詳細に並べる内訳。`ai-review`は判定のcheck-runが無いリポジトリでは落ちる */
  steps: IssuePullRequestStep[];
};

/**
 * 内訳を出す進捗Status（#2816）。`Develop PR`と`Release`だけ。
 *
 * `Develop`・`Done`はマージが済んだ後の定常状態で、待っているものが無い。計画・実装の段は
 * まだPRが無く、`ready`は着手前。**ここを広げるとPRを持たないIssueで空の内訳が出る。**
 */
export function isPullRequestWaitingStatus(status: ProgressStatusKey): boolean {
  return status === "develop-pr" || status === "release";
}

/** 内訳を導く材料。PR一覧（`PullRequestSummary`）とIssueの対応PR（`IssuePullRequest`）の共通部分 */
export type IssuePullRequestProgressSource = {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  ciState: CiState;
  /** `false`＝コンフリクトあり。`null`（判定中・未取得）は「なし」として扱わない */
  mergeable: boolean | null;
  mergeJudgement: MergeJudgement;
};

/**
 * Claudeのレビューの段に出す文言。`none`（check-runが無い）は段ごと落とすので入っていない。
 *
 * **写しを作らず、PR画面が持っている文言をそのまま組み立てる**（#2942）。以前はここに
 * `AI_REVIEW_SETTLED_LABEL`と同じ3語を書き写しており、同じ状態の呼び名が2か所にあった。
 * 短縮版（`AI_REVIEW_SHORT_LABEL`）を足すにあたって、写しの方を消してある。
 */
const AI_REVIEW_STEP_LABEL: Record<Exclude<AiReviewState, "none">, string> = {
  pending: MERGE_JUDGEMENT_STEP_LABEL["claude-review"],
  ...AI_REVIEW_SETTLED_LABEL,
};

/** マージの段に出す文言 */
const MERGE_STEP_LABEL = "マージ";
const MERGED_STEP_LABEL = "マージ済み";

/** PRが在ること自体を「実装は終わっている」として出す（#2816。Issueの本文にある要望そのもの） */
const OPENED_STEP_LABEL = "実装完了";

/**
 * 対応PRのCI状態（`PullRequestCiStatus`）を`CiState`へ戻す。
 *
 * Issueの対応PRだけが`PullRequestCiStatus`（マージボタンと同じ形）を持っており、PR一覧は
 * `CiState`のまま。**判定を2通り書かないために、内訳の入口で`CiState`へ寄せる。**
 * `none`（取れていない・draft・closed）は`unknown`＝状態を名乗らせない側へ倒す
 * （`toPullRequestCiStatus`の逆向きで、あちらと同じ扱い）。
 */
export function ciStateFromPullRequestCiStatus(status: PullRequestCiStatus | null): CiState {
  if (status === "in_progress") return "pending";
  if (status === "success") return "success";
  if (status === "failure") return "failure";
  return "unknown";
}

/**
 * Issueの対応PR（`IssuePullRequest`）を内訳の材料へ均す（#2816）。
 *
 * PR一覧（`PullRequestSummary`）はそのままこの材料の形をしているので、変換が要るのは
 * `PullRequestCiStatus`を持つIssue側だけ。
 */
export function toIssuePullRequestProgressSource(pullRequest: {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  ciStatus: PullRequestCiStatus | null;
  mergeable: boolean | null;
  mergeJudgement: MergeJudgement;
}): IssuePullRequestProgressSource {
  return {
    number: pullRequest.number,
    state: pullRequest.state,
    draft: pullRequest.draft,
    merged: pullRequest.merged,
    ciState: ciStateFromPullRequestCiStatus(pullRequest.ciStatus),
    mergeable: pullRequest.mergeable,
    mergeJudgement: pullRequest.mergeJudgement,
  };
}

/**
 * 内訳の対象にするPRを1本選ぶ（#2816）。
 *
 * 1つのIssueに複数のPRがぶら下がることがある（作り直し・分割）。**選ぶのは、まだ開いている
 * もののうち番号が最も大きいもの**——待っているのは常に最後に作られたPRで、古いPRの
 * 「マージ済み」を出しても次に何が起きるかは分からない。開いているPRが1本も無ければnull
 * （＝内訳を出さない）。
 */
export function selectProgressPullRequest<T extends IssuePullRequestProgressSource>(
  pullRequests: readonly T[],
): T | null {
  let selected: T | null = null;
  for (const pullRequest of pullRequests) {
    if (pullRequest.state !== "open" || pullRequest.merged) continue;
    if (selected === null || pullRequest.number > selected.number) selected = pullRequest;
  }
  return selected;
}

/**
 * 1本のPRから内訳と「いま待っているもの」を導く（#2816）。
 *
 * **待っているものの優先順は「止まっている > 動いている > 人待ち」。** 止まっているもの
 * （コンフリクト・CI失敗・レビュー失敗）を先に出さないと、放っておけば進むもので隠れる。
 *
 * 動いているもののうち判定（`mergeJudgement`）をCIより先に見るのは、PR画面の
 * `JUDGEMENT_STEP_ORDER`（#2066）と同じ理由。CIとレビューは並行して走り、レビューの方が
 * 長いことが多いため、実行順で選ぶとレビュー中もずっと「CI実行中」になる。
 */
export function buildIssuePullRequestProgress(
  pullRequest: IssuePullRequestProgressSource,
): IssuePullRequestProgress {
  const { mergeJudgement, ciState, mergeable, draft, merged } = pullRequest;
  const aiReviewState = mergeJudgement.aiReview.state;
  const judgementPending = mergeJudgement.state === "pending";

  const steps: IssuePullRequestStep[] = [
    { key: "opened", label: OPENED_STEP_LABEL, shortLabel: OPENED_STEP_LABEL, state: "done" },
    {
      key: "ci",
      label: CI_STATE_LABEL[ciState],
      // CIの呼び名（最長でも「CI状態は不明」）は狭い場所でもそのまま収まるので短縮版を持たない
      shortLabel: CI_STATE_LABEL[ciState],
      state:
        ciState === "failure"
          ? "failed"
          : ciState === "success"
            ? "done"
            : ciState === "pending"
              ? "current"
              : "pending",
    },
  ];
  // 判定のcheck-runが1件も無いリポジトリ（ワークフロー未配布・起動前・リリースPR）では
  // レビューの段を並べない。空の段を出すと「まだ来ていない」と読めてしまい、来ないものを
  // 待たせることになる
  if (aiReviewState !== "none") {
    steps.push({
      key: "ai-review",
      label: AI_REVIEW_STEP_LABEL[aiReviewState],
      shortLabel: AI_REVIEW_SHORT_LABEL[aiReviewState],
      state:
        aiReviewState === "failed"
          ? "failed"
          : aiReviewState === "pending"
            ? "current"
            : "done",
    });
  }
  // マージの段が`current`になるのは、前の段が全部片付いて本当にマージだけが残ったとき。
  // 判定・CI・レビューのどれかが動いている間は`pending`のままにする——「マージ」と
  // 「Claudeがレビュー中」が同時に光ると、どちらを待っているのか読めなくなる
  const beforeMergePending =
    judgementPending || ciState === "pending" || aiReviewState === "pending";
  steps.push({
    key: "merge",
    label: merged ? MERGED_STEP_LABEL : MERGE_STEP_LABEL,
    shortLabel: merged ? MERGED_STEP_LABEL : MERGE_STEP_LABEL,
    state: merged ? "done" : beforeMergePending ? "pending" : "current",
  });

  return { pullRequestNumber: pullRequest.number, steps, ...resolveWaiting() };

  function resolveWaiting(): { label: string; tone: IssuePullRequestProgressTone } {
    if (mergeable === false) return { label: "コンフリクトあり", tone: "attention" };
    if (ciState === "failure") return { label: CI_STATE_LABEL.failure, tone: "attention" };
    if (aiReviewState === "failed") {
      return { label: AI_REVIEW_STEP_LABEL.failed, tone: "attention" };
    }
    if (merged) return { label: MERGED_STEP_LABEL, tone: "running" };
    if (draft) return { label: "下書き", tone: "waiting" };
    if (judgementPending) {
      return { label: mergeJudgementLabel(mergeJudgement.step), tone: "running" };
    }
    if (ciState === "pending") return { label: CI_STATE_LABEL.pending, tone: "running" };
    return { label: "マージ待ち", tone: "waiting" };
  }
}

/**
 * 対応PRの集合から内訳を導く（#2816）。開いているPRが無ければnull＝内訳を出さない。
 * 一覧（`PullRequestSummary`）とIssue詳細（`IssuePullRequest`）の両方がこれを通る。
 */
export function resolveIssuePullRequestProgress(
  pullRequests: readonly IssuePullRequestProgressSource[],
): IssuePullRequestProgress | null {
  const target = selectProgressPullRequest(pullRequests);
  return target === null ? null : buildIssuePullRequestProgress(target);
}

/**
 * developへマージ（`Develop PR`）の中でどこまで来ているか（#2867）。一覧の進捗バーの
 * CI・レビュー／マージ待ちの2マスを内訳から決める。
 *
 * **見るのは「マージ」の段が`current`か`done`かだけ。** `buildIssuePullRequestProgress`は
 * 判定・CI・レビューのどれかが動いている間はマージを`pending`に保つので、レビューの
 * check-runが後から現れても「マージ待ち」から戻らない（済んだ段の数を分母で割ると、
 * `ai-review`の段が後から増えた時点で下がる）。内訳が無い（PRがまだ無い・取れていない）
 * ときは最初のマス。
 */
export type PullRequestPosition = "checks" | "merge";

export function resolvePullRequestPosition(
  progress: IssuePullRequestProgress | null,
): PullRequestPosition {
  const merge = progress?.steps.find((step) => step.key === "merge");
  return merge && (merge.state === "current" || merge.state === "done") ? "merge" : "checks";
}
