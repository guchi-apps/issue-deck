import { buildIssuePullRequestProgress } from "@/lib/issue-pull-request-progress";
import {
  MERGE_JUDGEMENT_PENDING_LABEL,
  mergeJudgementReason,
  requiresUserMerge,
} from "@/lib/pull-request-list";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * PR一覧の各行に、**場所を固定して**並べる状態の列（#2942）。
 *
 * 一覧はこれまで「出るものだけ」をバッジとして横に並べていたため、行ごとに数も並び順も変わり、
 * 縦に読み比べられなかった。さらにClaudeのレビューは実行中しか出ておらず（`MergeJudgementBadge`）、
 * 完了・省略・失敗は**一覧のどこにも出ていなかった**——`AiReviewBadge`はPR詳細とIssue画面だけが
 * 描いている。列を`CI` → `Claudeのレビュー` → `マージ`の3つに固定すれば、真ん中の列を縦に
 * 見るだけで「どのPRのレビューが終わっていて、どれが落ちたか」を拾える。
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
export type PullRequestRailSlotKey = "ci" | "ai-review" | "merge";

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
  "ai-review": "Claudeのレビュー",
  merge: "マージ",
};

/** ドラフトのPRではCI状態も判定も取りに行っていない（`fetchPullRequestCiStates`） */
const DRAFT_LABEL = "ドラフト";
const DRAFT_TITLE = "ドラフトのPRでは、CI状態もマージ可否の判定も取得していません。";

/** レビューのcheck-runが1件も無いPR。**「まだ来ていない」とは言わない**（来ないため） */
const AI_REVIEW_ABSENT_LABEL = "—";
const AI_REVIEW_ABSENT_TITLE =
  "このPRではClaudeのレビューが走りません（ワークフローが配られていない・リリースPR・起動前のいずれか）。";

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

  return [ciSlot(), aiReviewSlot(), mergeSlot()];

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

  /**
   * マージの枠だけは、内訳の段（`merge`）に一覧固有の事情を重ねる。
   *
   * **順番は「止まっている > 機械が動いている > 人待ち」。** 止まっているもの
   * （コンフリクト）を先に出さないと、放っておけば進むものに隠れる——`resolveWaiting`と
   * 同じ考え方で、`00.check-user`のamberはその後に来る。
   */
  function mergeSlot(): PullRequestRailSlot {
    if (pullRequest.merged) {
      return slot("merge", "マージ済み", "done", "developへマージ済みです。", null);
    }
    if (pullRequest.mergeable === false) {
      return slot("merge", CONFLICT_LABEL, "failed", CONFLICT_TITLE, null);
    }
    if (pullRequest.mergeJudgement.state === "pending") {
      // 段の名前（「Claudeがレビュー中」など）はこの幅に収まらないので、ボタンと同じ「判定中」を
      // 出し、どの段を待っているかは`title`（`mergeJudgementReason`）に譲る。レビューの段の
      // 進み具合は隣の枠が既に出している
      return slot(
        "merge",
        MERGE_JUDGEMENT_PENDING_LABEL,
        "current",
        mergeJudgementReason(pullRequest.mergeJudgement.step),
        pullRequest.mergeJudgement.runUrl,
      );
    }
    if (requiresUserMerge(pullRequest)) {
      return slot("merge", USER_MERGE_LABEL, "waiting", USER_MERGE_TITLE, null);
    }
    if (pullRequest.autoMergeEnabled) {
      return slot("merge", AUTO_MERGE_LABEL, "pending", AUTO_MERGE_TITLE, null);
    }
    const step = stepOf("merge");
    if (step === null) return slot("merge", AI_REVIEW_ABSENT_LABEL, "absent", "", null);
    // 内訳の`current`は「前の段が全部片付いてマージだけが残った」状態で、動いているのは機械では
    // なく順番待ち。Issue詳細の内訳（`PullRequestProgressSteps`）が同じ段をamberにしているのと
    // 揃える
    return slot(
      "merge",
      step.shortLabel,
      step.state === "current" ? "waiting" : step.state,
      step.label,
      null,
    );
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
