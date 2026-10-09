import type { PrReviewGateState } from "@/lib/dispatch/pr-review";
import type { CheckUserReason } from "@/lib/github/approval-labels";
import { MERGE_CONFIRM_REQUIRED_LABEL, PREVIEW_REQUIRED_LABEL } from "@/lib/github/start-implementation";

/**
 * バックアップCIが合格したPRを、**GitHub Actionsを使わずに**developへマージするまでの判定（#4114）。
 * DB・GitHubへの読み書きは`merge-service.ts`。設計は docs/backup-ci.md「6. 障害時の切替」。
 *
 * 通常の経路（`claude-review-develop.yml`の`codex-review`→`auto-merge`）はActionsの中で判定するため、
 * Actionsが止まるとレビューも始まらずマージ判定も動かない。ここでは同じ判定材料を**issue-deckの
 * サーバー側で**読み、同じ方向（止める理由が1つでもあれば人へ渡す）で決める。
 *
 * - レビューはサブPCのCodex（`PR_REVIEW`）で行う。Actions上のClaudeの代わり（#4149のワークフロー
 *   変更PRと同じ扱い）。同じPR・HEADのジョブが既にあれば活性キーで相乗りし、二重に積まない
 * - マージ方針はdevelop向けの`merge-policy: relaxed`と同じ。自動マージ不可カテゴリでは止めず、
 *   `22.merge-confirm-required`・`23.preview-required`・`00.check-user`・`.shared-context/`の混入・
 *   レビューの要修正／要確認／失敗・コンフリクトで止める
 * - マージは記録したheadのSHAを`expectedHeadSha`として渡す（その間にpushされればGitHubが断る）
 */

/** マージまでの進み具合。`null`（未着手）と`reviewing`だけが巡回の対象 */
export const BACKUP_CI_MERGE_STATUSES = ["reviewing", "merged", "held", "gave_up", "skipped"] as const;
export type BackupCiMergeStatus = (typeof BACKUP_CI_MERGE_STATUSES)[number];

export function parseBackupCiMergeStatus(value: string | null | undefined): BackupCiMergeStatus | null {
  return (BACKUP_CI_MERGE_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as BackupCiMergeStatus)
    : null;
}

export const BACKUP_CI_MERGE_STATUS_LABELS: Record<BackupCiMergeStatus, string> = {
  reviewing: "サブPCのレビュー待ち",
  merged: "issue-deckがdevelopへマージしました",
  held: "自動マージを止めて確認待ちにしました",
  gave_up: "マージできず確認待ちにしました",
  skipped: "自動マージの対象外",
};

/** マージAPIの失敗を許す回数。巡回は約30秒ごとなので、5分ほど試して人へ渡す */
export const BACKUP_CI_MERGE_MAX_ATTEMPTS = 10;

/** `issue-<番号>`ブランチから対応Issueを引く（Actionsの`identify-issue`と同じ規約） */
export function issueNumberFromHeadRef(headRef: string): number | null {
  const match = /^issue-(\d+)$/.exec(headRef);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type BackupCiMergeInput = {
  run: { id: string; status: string; headSha: string; baseSha: string; mergeStatus: string | null };
  /** 共通チェックの採用状況（`CiGateState`） */
  gate: { source: string; sourceRef: string | null; state: string; headSha: string; baseSha: string } | null;
  pr: {
    state: string;
    merged: boolean;
    draft: boolean;
    headSha: string;
    baseSha: string;
    /** GitHubが計算中ならnull */
    mergeable: boolean | null;
    mergeableState: string | null;
  };
  issueNumber: number | null;
  /** 対応Issueのラベル。Issueが無ければnull */
  issueLabels: readonly string[] | null;
  /** 差分に`.shared-context/`が入っているか */
  sharedContextChanged: boolean;
  /** このheadに対するレビューの状態。まだ積んでいなければ`missing` */
  review: PrReviewGateState;
};

export type BackupCiMergeDecision =
  /** この実行では何もしない。`finalStatus`があれば記録して巡回の対象から外す */
  | { kind: "ignore"; reason: string; finalStatus?: BackupCiMergeStatus }
  | { kind: "request_review" }
  | { kind: "wait"; reason: string }
  /**
   * 自動マージせず人へ渡す。`checkReason`がnullなら`00.check-user`を付けない（既に付いている・
   * 付ける先のIssueが無い）。`notify`はコメントを残すか
   */
  | { kind: "hold"; reason: string; checkReason: CheckUserReason | null; notify: boolean }
  | { kind: "merge"; expectedHeadSha: string };

export type BackupCiMergePrecheckInput = Pick<BackupCiMergeInput, "run" | "gate" | "pr">;

/**
 * Issueのラベル・差分・レビューを読まずに決められる部分。**ここで決まれば、GitHubへの追加の問い合わせを
 * しない**（巡回は約30秒ごとなので、待つだけの回を安く済ませる）。決まらなければnull
 */
export function precheckBackupCiMerge(input: BackupCiMergePrecheckInput): BackupCiMergeDecision | null {
  const { run, gate, pr } = input;
  const mergeStatus = parseBackupCiMergeStatus(run.mergeStatus);
  if (run.status !== "passed") return { kind: "ignore", reason: "バックアップCIが合格していません。" };
  if (mergeStatus !== null && mergeStatus !== "reviewing") {
    return { kind: "ignore", reason: "マージの判定は済んでいます。" };
  }
  if (pr.merged) return { kind: "ignore", reason: "PRは既にマージされています。", finalStatus: "skipped" };
  if (pr.state !== "open") return { kind: "ignore", reason: "PRが閉じられています。", finalStatus: "skipped" };
  // head/baseが動いた合格は使わない（バックアップCIの照合が`superseded`にする）
  if (pr.headSha !== run.headSha || pr.baseSha !== run.baseSha) {
    return { kind: "ignore", reason: "PRのhead/baseが更新されました。" };
  }
  // 共通チェックがこの実行の合格を採用しているときだけ進む。Actionsの結果が後から採用されたなら、
  // マージはActionsの通常の経路（auto-merge）に任せる
  if (!gate || gate.headSha !== run.headSha || gate.baseSha !== run.baseSha) {
    return { kind: "wait", reason: "共通チェックがまだこの合格を反映していません。" };
  }
  if (gate.source !== "backup" || gate.sourceRef !== run.id) {
    return {
      kind: "ignore",
      reason: "共通チェックはGitHub Actionsの結果を採用しています（通常の経路でマージ判定します）。",
      finalStatus: "skipped",
    };
  }
  if (gate.state !== "success") return { kind: "wait", reason: "共通チェックが成功になっていません。" };
  if (pr.draft) return { kind: "wait", reason: "下書きのPRは自動マージしません。" };
  return null;
}

export function decideBackupCiMerge(input: BackupCiMergeInput): BackupCiMergeDecision {
  const pre = precheckBackupCiMerge(input);
  if (pre) return pre;
  const { run, pr, review } = input;

  // 止める理由は、Codexの枠を使う前に見る
  if (input.issueNumber === null || input.issueLabels === null) {
    return {
      kind: "hold",
      reason: "対応Issue（`issue-<番号>`ブランチ）を特定できないため、自動マージしません。",
      checkReason: null,
      notify: true,
    };
  }
  if (input.issueLabels.includes("00.check-user")) {
    return {
      kind: "hold",
      reason: "対応Issueが既に確認待ち（00.check-user）のため、自動マージしません。",
      checkReason: null,
      notify: false,
    };
  }
  for (const label of [MERGE_CONFIRM_REQUIRED_LABEL, PREVIEW_REQUIRED_LABEL]) {
    if (input.issueLabels.includes(label)) {
      return { kind: "hold", reason: `対応Issueに\`${label}\`が付いているため。`, checkReason: "merge", notify: true };
    }
  }
  if (input.sharedContextChanged) {
    return {
      kind: "hold",
      reason: "共有知識のcheckout先（`.shared-context/`）が差分に含まれているため。",
      checkReason: "merge",
      notify: true,
    };
  }
  if (pr.mergeable === false || pr.mergeableState === "dirty") {
    return { kind: "hold", reason: "developとコンフリクトしているため。", checkReason: "merge", notify: true };
  }

  switch (review.state) {
    case "missing":
    case "stale":
      return { kind: "request_review" };
    case "pending":
      return { kind: "wait", reason: "サブPCのレビューを待っています。" };
    case "failed":
      return {
        kind: "hold",
        reason: `サブPCのCodexレビューを完了できなかったため（${review.reason}）。`,
        checkReason: "blocked",
        notify: true,
      };
    case "done":
      if (review.verdict !== "lgtm") {
        return {
          kind: "hold",
          reason: `サブPCのCodexレビューが\`${review.verdict}\`と判定したため。詳細はPRのレビューコメントを確認してください。`,
          checkReason: "merge",
          notify: true,
        };
      }
  }

  // GitHubがマージ可否を計算し終えるまで待つ
  if (pr.mergeable === null) return { kind: "wait", reason: "GitHubがマージ可否を計算しています。" };
  return { kind: "merge", expectedHeadSha: run.headSha };
}

/** 止めたときにIssue（無ければPR）へ残すコメント */
export function buildBackupCiHoldComment(input: { prNumber: number; headSha: string; reason: string }): string {
  return [
    `⚠️ GitHub Actionsの代わりにバックアップCI（CircleCI）が合格したPR #${input.prNumber}（\`${input.headSha.slice(0, 7)}\`）を、issue-deckがdevelopへ自動マージしようとしましたが、次の理由で止めました。`,
    "",
    `- ${input.reason}`,
    "",
    "内容を確認してから、issue-deckのPR詳細でマージしてください（docs/backup-ci.md「6. 障害時の切替」）。",
    "",
    "<!-- issue-deck-source:backup-ci-merge -->",
  ].join("\n");
}

/** マージしたときにPRへ残すコメント */
export function buildBackupCiMergedComment(input: { headSha: string; baseSha: string; mergeCommitSha: string | null }): string {
  return [
    `✅ バックアップCI（CircleCI）の合格と、サブPCのCodexレビュー（LGTM）を確認したため、issue-deckがdevelopへマージしました（head \`${input.headSha.slice(0, 7)}\` / base \`${input.baseSha.slice(0, 7)}\`${input.mergeCommitSha ? ` → \`${input.mergeCommitSha.slice(0, 7)}\`` : ""}）。`,
    "",
    "GitHub Actionsの`claude-review-develop.yml`は経由していません（docs/backup-ci.md「6. 障害時の切替」）。",
    "",
    "<!-- issue-deck-source:backup-ci-merge -->",
  ].join("\n");
}
