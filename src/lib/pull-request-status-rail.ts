import { buildIssuePullRequestProgress } from "@/lib/issue-pull-request-progress";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * PR一覧の各行に、**場所を固定して**並べる状態の列（#2942）。
 *
 * 一覧はこれまで「出るものだけ」をバッジとして横に並べていたため、行ごとに数も並び順も変わり、
 * 縦に読み比べられなかった。さらにレビューは実行中しか出ておらず（`MergeJudgementBadge`）、
 * 完了・省略・失敗は**一覧のどこにも出ていなかった**——`AiReviewBadge`はPR詳細とIssue画面だけが
 * 描いている。列を`CI` → `コンフリクト` → `レビュー`の3つに固定すれば、状態を縦に
 * 見るだけで、対応が必要なPRを拾える。
 *
 * **状態と文言は新しく作らない。** 材料はIssue詳細の「developへマージ」の内訳
 * （[`issue-pull-request-progress.ts`](./issue-pull-request-progress.ts)の
 * `buildIssuePullRequestProgress`。#2816）をそのまま通し、PR一覧にしか無い事情
 * （ドラフト・コンフリクト・判定中・Auto-merge・ユーザーのマージ待ち）だけをここで重ねる。
 * 判定を2通り書くと、#2145・#2150で起きたように同じ状態が画面ごとに違う名前で出る。
 *
 * **GitHub APIの消費は増えない。** 見ているのはPR一覧が今も受け取っている値
 * （`ciState`・`mergeJudgement.aiReview`・`mergeable`・`autoMergeEnabled`）だけ。
 *
 * この判定の外に残すのは`repairRun`（自動修復の実行中）だけで、あちらは経過時間を数え直す
 * 生きたバッジ（`RepairRunBadge`）なので、レールの右へ今までどおり別に並べる。
 */
export type PullRequestRailSlotKey = "ci" | "conflict" | "ai-review";

/**
 * 1枠の状態。色とアイコンの出し分けはこれだけで決まる。
 *
 * - `done` … 通り過ぎた
 * - `current` … 機械が動いている（放っておけば進む）
 * - `waiting` … 人が動かないと進まない
 * - `failed` … そこで止まっている
 * - `pending` … まだそこまで来ていない
 * - `absent` … その段自体がこのPRには無い。**場所だけ空けて何も主張しない**
 */
export type PullRequestRailSlotState =
  | "done"
  | "current"
  | "waiting"
  | "failed"
  | "pending"
  | "absent";

export type PullRequestRailSlot = {
  key: PullRequestRailSlotKey;
  /** 列そのものの意味。読み上げと`title`の見出しに使う */
  columnLabel: string;
  /** 枠に出す短い文言 */
  label: string;
  state: PullRequestRailSlotState;
  /** マウスを載せたときに読める全文。短縮していない言い回しか、その状態の理由 */
  title: string;
  /** 実行ログへのリンク。無ければnull */
  href: string | null;
};

/** 列の見出し。読み上げ（`aria-label`）と`title`の頭に付ける */
const COLUMN_LABEL: Record<PullRequestRailSlotKey, string> = {
  ci: "CI",
  conflict: "コンフリクト",
  "ai-review": "レビュー",
};

/** ドラフトのPRではCI状態も判定も取りに行っていない（`fetchPullRequestCiStates`） */
const DRAFT_LABEL = "ドラフト";
const DRAFT_TITLE = "ドラフトのPRでは、CI状態もマージ可否の判定も取得していません。";

/** レビューのcheck-runが1件も無いPR。**「まだ来ていない」とは言わない**（来ないため） */
const AI_REVIEW_ABSENT_LABEL = "—";
const AI_REVIEW_ABSENT_TITLE =
  "このPRではレビュー工程がありません（ワークフローが配られていない・リリースPR・起動前のいずれか）。";

const CONFLICT_LABEL = "コンフリクト";
const CONFLICT_TITLE =
  "baseブランチとコンフリクトしています。解消するまでマージできません（画面から自動解消を起動できます）。";

const USER_MERGE_LABEL = "マージ待ち";
const USER_MERGE_TITLE =
  "自動ではマージされません。ユーザーのマージが必要です（00.check-user / 01.check-merge）。";

const AUTO_MERGE_LABEL = "自動マージ";
const AUTO_MERGE_TITLE = "Auto-mergeが有効です。CI通過後に自動でマージされます。";

/**
 * 1本のPRから、一覧に並べる3枠を作る（#2942）。**枠は常に3つ返す**——1つでも欠けると
 * 行をまたいだ列の位置がずれ、縦に読み比べるという狙いそのものが崩れる。
 */
export function buildPullRequestStatusRail(
  pullRequest: PullRequestSummary,
): PullRequestRailSlot[] {
  const progress = buildIssuePullRequestProgress(pullRequest);
  const stepOf = (key: "ci" | "ai-review" | "merge") =>
    progress.steps.find((step) => step.key === key) ?? null;

  return [ciSlot(), conflictSlot(), aiReviewSlot()];

  function ciSlot(): PullRequestRailSlot {
    if (pullRequest.draft) {
      return slot("ci", DRAFT_LABEL, "pending", DRAFT_TITLE, null);
    }
    const step = stepOf("ci");
    // `buildIssuePullRequestProgress`はCIの段を必ず返すが、型の上ではnullがありうる
    if (step === null) return slot("ci", AI_REVIEW_ABSENT_LABEL, "absent", "", null);
    return slot("ci", step.shortLabel, step.state, step.label, null);
  }

  function aiReviewSlot(): PullRequestRailSlot {
    const step = stepOf("ai-review");
    if (step === null) {
      return slot("ai-review", AI_REVIEW_ABSENT_LABEL, "absent", AI_REVIEW_ABSENT_TITLE, null);
    }
    return slot(
      "ai-review",
      step.shortLabel,
      step.state,
      step.label,
      pullRequest.mergeJudgement.aiReview.runUrl,
    );
  }

  function conflictSlot(): PullRequestRailSlot {
    if (pullRequest.mergeable === false) {
      return slot("conflict", CONFLICT_LABEL, "failed", CONFLICT_TITLE, null);
    }
    if (pullRequest.mergeable === true) {
      return slot("conflict", "解消済み", "done", "コンフリクトはありません。", null);
    }
    return slot("conflict", "確認中", "current", "コンフリクトの有無を確認しています。", null);
  }

  function slot(
    key: PullRequestRailSlotKey,
    label: string,
    state: PullRequestRailSlotState,
    title: string,
    href: string | null,
  ): PullRequestRailSlot {
    return { key, columnLabel: COLUMN_LABEL[key], label, state, title, href };
  }
}
