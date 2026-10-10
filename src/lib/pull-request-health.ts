import { autoRepairStopReasonLabel, classifyAutoRepairStopReason } from "@/lib/github/pull-request-auto-repair-status";
import { REPAIR_KIND_RUNNING_SHORT_LABEL } from "@/lib/github/pull-request-repair";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import { resolveAiReviewVerdictState } from "@/lib/pull-request-list";
import type { PullRequestAgentReviewState } from "@/lib/dispatch/pr-review-agent-summary";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * ブランチ画面が1本のPRについて並べる4つの状態（CI・レビュー・コンフリクト・自動修正）と、
 * 折り畳み行の件数へ数える分類（#4015）。
 *
 * **4軸は互いを隠さない。** CI成功がレビュー要修正やコンフリクトを隠さないよう、
 * 軸ごとに独立した枠を返し、問題と対応状況（自動修正）も別の枠にする。
 * 材料はPR一覧が既に受け取っている値だけで、GitHub APIの消費は増えない。
 * 判定の鮮度（`resolveReviewVerdictFreshness`）とレビューの判定
 * （`resolveAiReviewVerdictState`）はPR一覧・PR詳細と同じ部品を通す。
 *
 * **根拠が無い状態は成功・完了に見せない。** CIの待機と実行はcheck-runの`status`が分かるときだけ
 * 区別し、レビューは「ジョブが正常終了した」と「判定が問題なし」を分け、コンフリクトの未取得は
 * 「なし」と言わない。
 */

/**
 * 状態の配色の意味（#4293）。`wait`＝人の承認・確認・操作待ち（琥珀）、`bad`＝失敗・要修正・問題による停止（赤）、
 * `run`＝実行中（紫）、`idle`＝実行待ち・未確認・意図的な停止（灰色＋状態ごとのアイコン）、`ok`＝成功・完了（緑）。
 */
export type PullRequestHealthTone = "bad" | "wait" | "run" | "ok" | "idle";

export type PullRequestHealthSlotKey = "ci" | "review" | "conflict" | "repair";

/**
 * 折り畳み行へ数える分類。**1本のPRが複数に該当してよい**（件数はカテゴリごとのPR数で、
 * 合計はPR数にならない）。
 */
export type PullRequestHealthCategory =
  | "ci-failed"
  | "review-changes-requested"
  | "review-needs-check"
  | "review-failed"
  | "conflict"
  | "ci-running"
  | "review-running"
  | "repair-fixing"
  | "revalidating"
  | "repair-stopped";

export type PullRequestHealthSlot = {
  key: PullRequestHealthSlotKey;
  /** 枠の見出し（読み上げ・`title`の頭） */
  columnLabel: string;
  /** 状態を表す記号。色だけに頼らず、文字とあわせて出す */
  icon: string;
  /** 常時表示する短い文言 */
  label: string;
  tone: PullRequestHealthTone;
  /** 理由を含む全文（スマホでは出ないので、必要な情報はlabelに入れる） */
  title: string;
  /** 実行ログ・詳細への遷移先。無ければnull */
  href: string | null;
  /**
   * 展開先。`ci`はCIの内訳（#3662）、それ以外はPR詳細へ進む。画面側が出し分けるための印で、
   * 判定には使わない。
   */
  detail: "ci-breakdown" | "agent-breakdown" | "pull-request" | null;
  /**
   * レビュー枠のエージェント別の内訳（#4024）。Codex等の`PR_REVIEW`ジョブがあるときだけ入り、
   * 全員のLGTMが揃ったときだけ枠が完了になる。
   */
  breakdown?: PullRequestHealthBreakdownRow[];
};

export type PullRequestHealthBreakdownRow = {
  agentLabel: string;
  icon: string;
  label: string;
  tone: PullRequestHealthTone;
};

/**
 * 人の対応が要るか・待てば進むか・どちらでもないか。
 *
 * - `human` … 問題があり、それを直している自動修正が走っていない
 * - `auto` … 自動修正中・再検証待ち、またはCI・レビューが動いている（待てば進む）
 * - `clear` … 問題も実行中のものも無い
 */
export type PullRequestHealthDisposition = "human" | "auto" | "clear";

export type PullRequestHealth = {
  slots: PullRequestHealthSlot[];
  categories: PullRequestHealthCategory[];
  disposition: PullRequestHealthDisposition;
  /** 要修正・CI失敗・コンフリクト・検証中のいずれかがあり、単なる「マージ待ち」と言えない */
  blocksPlainMergeWait: boolean;
  /** 失敗・要修正・問題による停止（赤）の枠が1つでもある。レーン見出しを赤にするかの判定に使う */
  failing: boolean;
};

type HealthSource = Pick<
  PullRequestSummary,
  | "state"
  | "merged"
  | "draft"
  | "kind"
  | "htmlUrl"
  | "headSha"
  | "ciState"
  | "ciChecks"
  | "mergeable"
  | "mergeJudgement"
  | "reviewVerdict"
  | "repairRun"
  | "autoRepair"
  | "agentReviews"
>;

const COLUMN_LABEL: Record<PullRequestHealthSlotKey, string> = {
  ci: "CI",
  review: "レビュー",
  conflict: "コンフリクト",
  repair: "自動修正",
};

/** check-runのstatusのうち、まだ始まっていないもの */
const QUEUED_CHECK_STATUSES = new Set(["queued", "waiting", "pending", "requested"]);

const TONE_SEVERITY: Record<PullRequestHealthTone, number> = { ok: 0, idle: 1, run: 2, wait: 3, bad: 4 };

/** エージェント別レビューの状態 → [記号, 文言, 色, 数えるカテゴリ] */
const AGENT_REVIEW_STATE: Record<
  PullRequestAgentReviewState,
  [string, string, PullRequestHealthTone, PullRequestHealthCategory | null]
> = {
  pending: ["●", "レビュー中", "run", "review-running"],
  lgtm: ["✓", "LGTM", "ok", null],
  "needs-check": ["△", "要確認", "wait", "review-needs-check"],
  "changes-requested": ["✕", "要修正", "bad", "review-changes-requested"],
  failed: ["✕", "レビュー失敗", "bad", "review-failed"],
};

type SlotInput = Omit<PullRequestHealthSlot, "key" | "columnLabel">;

function makeSlot(key: PullRequestHealthSlotKey, slot: SlotInput): PullRequestHealthSlot {
  return { key, columnLabel: COLUMN_LABEL[key], ...slot };
}

/** 対象はopenでdraftでないPR。それ以外は現在の問題として数えない（マージ済み・クローズ済み・下書き） */
export function isHealthTarget(pullRequest: Pick<HealthSource, "state" | "merged" | "draft">): boolean {
  return pullRequest.state === "open" && !pullRequest.merged && !pullRequest.draft;
}

export function resolvePullRequestHealth(pullRequest: HealthSource): PullRequestHealth {
  if (!isHealthTarget(pullRequest)) {
    return { slots: [], categories: [], disposition: "clear", blocksPlainMergeWait: false, failing: false };
  }

  const categories = new Set<PullRequestHealthCategory>();
  const ci = ciSlot();
  const review = withAgentBreakdown(claudeReviewSlot());
  const conflict = conflictSlot();
  const repair = repairSlot();

  const problems: PullRequestHealthCategory[] = [
    "ci-failed",
    "review-changes-requested",
    "review-needs-check",
    "review-failed",
    "conflict",
  ];
  const hasProblem = problems.some((category) => categories.has(category));
  const repairing =
    categories.has("repair-fixing") ||
    pullRequest.autoRepair?.status === "running" ||
    pullRequest.autoRepair?.status === "dispatching";
  const inProgress =
    categories.has("ci-running") ||
    categories.has("review-running") ||
    categories.has("revalidating") ||
    categories.has("repair-fixing");

  // 直している最中（自動修正中・再検証待ち）は、問題が残っていても「待てば進む」側に置く。
  // 問題の表示そのものは枠に残るので、解消済みに見えることは無い。
  const disposition: PullRequestHealthDisposition = repairing
    ? "auto"
    : hasProblem || categories.has("repair-stopped")
      ? "human"
      : inProgress
        ? "auto"
        : "clear";

  return {
    slots: [ci, review, conflict, ...(repair ? [repair] : [])],
    categories: [...categories],
    disposition,
    blocksPlainMergeWait: hasProblem || inProgress || categories.has("repair-stopped"),
    failing: [ci, review, conflict, repair].some((slot) => slot?.tone === "bad"),
  };

  function ciSlot(): PullRequestHealthSlot {
    const detail = "ci-breakdown" as const;
    switch (pullRequest.ciState) {
      case "failure":
        categories.add("ci-failed");
        return makeSlot("ci", {
          icon: "✕",
          label: "CI失敗",
          tone: "bad",
          title: "失敗したチェックがあります。内訳で失敗したジョブを確認できます。",
          href: null,
          detail,
        });
      case "success":
        return makeSlot("ci", {
          icon: "✓",
          label: "CI成功",
          tone: "ok",
          title: "すべてのチェックが通っています。",
          href: null,
          detail,
        });
      case "pending": {
        categories.add("ci-running");
        const unfinished = pullRequest.ciChecks.filter((check) => check.status !== "completed");
        const running = unfinished.some((check) => check.status === "in_progress");
        const queued =
          unfinished.length > 0 &&
          unfinished.every((check) => QUEUED_CHECK_STATUSES.has(check.status));
        // 根拠（check-runのstatus）が取れないときは、実行中とも待機とも言い切らない
        const [icon, label, title, tone] = running
          ? (["●", "CI実行中", "実行中のチェックがあります。", "run"] as const)
          : queued
            ? (["◔", "CI待機", "チェックはまだ開始されていません（実行待ち）。", "idle"] as const)
            : (["？", "CI未完了", "チェックが完了していません。待機か実行中かは取得できていません。", "idle"] as const);
        return makeSlot("ci", { icon, label, tone, title, href: null, detail });
      }
      default:
        return makeSlot("ci", {
          icon: "？",
          label: "CI未確認",
          tone: "idle",
          title: "CIの状態を取得できていません（権限不足・チェック未検出・取得失敗）。成功とは限りません。",
          href: null,
          detail,
        });
    }
  }

  /**
   * Claudeの判定（`claudeSlot`）と、Codex等の`PR_REVIEW`の状態を合わせて、枠を1つにする（#4024）。
   * **必要な全員のLGTMが揃ったときだけ完了**で、1人でも要修正・失敗・未完了なら、
   * いちばん重い状態を枠に出す。ジョブを持たないエージェントは必須とみなさない。
   */
  function withAgentBreakdown(claudeSlot: PullRequestHealthSlot): PullRequestHealthSlot {
    const agents = pullRequest.agentReviews ?? [];
    if (agents.length === 0) return claudeSlot;
    const rows: { row: PullRequestHealthBreakdownRow; slot: PullRequestHealthSlot | null }[] = [];
    // 「レビューなし」はClaudeの工程自体が無い状態で、必須の欠落ではない
    if (claudeSlot.detail !== null || claudeSlot.href !== null) {
      rows.push({
        row: { agentLabel: "Claude", icon: claudeSlot.icon, label: claudeSlot.label, tone: claudeSlot.tone },
        slot: claudeSlot,
      });
    }
    for (const review of agents) {
      const agentLabel = review.agent === "codex" ? "Codex" : "Claude（ジョブ）";
      const [icon, label, tone, category] = AGENT_REVIEW_STATE[review.state];
      if (category) categories.add(category);
      rows.push({
        row: { agentLabel, icon, label, tone },
        slot: makeSlot("review", {
          icon,
          label: `${agentLabel}${label}`,
          tone,
          title: `${agentLabel}のレビュー: ${label}。内訳で各エージェントの状態を確認できます。`,
          href: null,
          detail: "agent-breakdown",
        }),
      });
    }
    const breakdown = rows.map((entry) => entry.row);
    const worst = rows.reduce((a, b) => (TONE_SEVERITY[b.row.tone] > TONE_SEVERITY[a.row.tone] ? b : a));
    const allOk = rows.every((entry) => entry.row.tone === "ok");
    const names = rows.map((entry) => entry.row.agentLabel).join("・");
    const base = allOk
      ? makeSlot("review", {
          icon: "✓",
          label: "レビューLGTM（全員）",
          tone: "ok",
          title: `${names}のレビューがすべて問題なしと判定しています。`,
          href: claudeSlot.href,
          detail: "agent-breakdown",
        })
      : (worst.slot ?? claudeSlot);
    return { ...base, detail: "agent-breakdown", breakdown };
  }

  function claudeReviewSlot(): PullRequestHealthSlot {
    const { aiReview } = pullRequest.mergeJudgement;
    const href = aiReview.runUrl;
    const detail = "pull-request" as const;
    const freshness = resolveReviewVerdictFreshness({
      reviewedSha: pullRequest.reviewVerdict?.reviewedSha,
      headSha: pullRequest.headSha,
    });

    if (aiReview.state === "pending") {
      categories.add("review-running");
      const stale = freshness === "stale";
      return makeSlot("review", {
        icon: "●",
        label: stale ? "再レビュー中" : "レビュー中",
        tone: "run",
        title: stale
          ? "新しいコミットに対するレビューが実行されています。"
          : "レビューが実行されています。",
        href,
        detail,
      });
    }
    // 旧コミットの判定（要修正もLGTMも）を、現在の確定結果として残さない
    if (freshness === "stale") {
      categories.add("revalidating");
      return makeSlot("review", {
        icon: "◔",
        label: "再検証待ち",
        tone: "idle",
        title:
          "判定は旧コミットに対するものです。新しいコミットのレビューはまだ開始を確認できていません。",
        href,
        detail,
      });
    }

    switch (resolveAiReviewVerdictState(aiReview, pullRequest.reviewVerdict)) {
      case "changes-requested":
        categories.add("review-changes-requested");
        return makeSlot("review", {
          icon: "✕",
          label: "レビュー要修正",
          tone: "bad",
          title: "レビューが修正を求めています。詳細で指摘を確認できます。",
          href,
          detail,
        });
      case "needs-check":
        categories.add("review-needs-check");
        return makeSlot("review", {
          icon: "△",
          label: "レビュー要確認",
          tone: "wait",
          title: "マージ前に人が確認すべき点があります。",
          href,
          detail,
        });
      case "failed":
        categories.add("review-failed");
        return makeSlot("review", {
          icon: "✕",
          label: "レビュー失敗",
          tone: "bad",
          title: "レビューのジョブが失敗しました。完了とは扱いません。",
          href,
          detail,
        });
      case "skipped":
        return makeSlot("review", {
          icon: "－",
          label: "レビュー省略",
          tone: "idle",
          title: "差分が小さいためレビューは実行されていません。LGTMではありません。",
          href,
          detail,
        });
      case "ok":
        // ジョブの正常終了と「問題なし」は別。判定の記録が読めるときだけ完了と言う
        return pullRequest.reviewVerdict?.reviewKind === "ok"
          ? makeSlot("review", {
              icon: "✓",
              label: "レビューLGTM",
              tone: "ok",
              title: "最新のコミットに対するレビューが問題なしと判定しています。",
              href,
              detail,
            })
          : makeSlot("review", {
              icon: "－",
              label: "判定未記録",
              tone: "idle",
              title: "レビューのジョブは終了しましたが、判定の記録を読めていません。LGTMとは限りません。",
              href,
              detail,
            });
      default:
        return makeSlot("review", {
          icon: "－",
          label: "レビューなし",
          tone: "idle",
          title:
            "このPRにはレビュー工程がありません（ワークフロー未配布・リリースPR・起動前のいずれか）。",
          href: null,
          detail: null,
        });
    }
  }

  function conflictSlot(): PullRequestHealthSlot {
    if (pullRequest.mergeable === false) {
      categories.add("conflict");
      return makeSlot("conflict", {
        icon: "✕",
        label: "競合あり",
        tone: "bad",
        title: "baseブランチとコンフリクトしています。解消するまでマージできません。",
        href: null,
        detail: "pull-request",
      });
    }
    if (pullRequest.mergeable === true) {
      return makeSlot("conflict", {
        icon: "✓",
        label: "競合なし",
        tone: "ok",
        title: "baseブランチとコンフリクトしていません。",
        href: null,
        detail: null,
      });
    }
    return makeSlot("conflict", {
      icon: "？",
      label: "競合未確認",
      tone: "idle",
      title: "GitHubが判定中か、まだ取得できていません。「なし」とは限りません。",
      href: null,
      detail: null,
    });
  }

  function repairSlot(): PullRequestHealthSlot | null {
    const run = pullRequest.repairRun;
    if (run) {
      categories.add("repair-fixing");
      return makeSlot("repair", {
        icon: "⚙",
        label: REPAIR_KIND_RUNNING_SHORT_LABEL[run.kind],
        tone: "run",
        title: "自動修正が実行中です。問題の表示は、解消が確認できるまで残ります。",
        href: run.runUrl,
        detail: run.runUrl ? null : "pull-request",
      });
    }
    const loop = pullRequest.autoRepair;
    if (loop && (loop.status === "running" || loop.status === "dispatching")) {
      categories.add("revalidating");
      return makeSlot("repair", {
        icon: "◔",
        label: `再検証待ち ${loop.round}/${loop.maxRounds}`,
        // 新しいコミットの結果を待っているだけで、何かが実行中だとは言えない
        tone: "idle",
        title: "修正を反映しました。新しいコミットのCI・レビューの結果を待っています。",
        href: null,
        detail: "pull-request",
      });
    }
    if (loop?.status === "stopped" && hasUnresolvedProblem()) {
      // 停止理由で分ける。人が止めた・PRが閉じられた＝意図的（灰）、人の判断待ち＝琥珀、
      // それ以外と理由不明は問題による停止（赤）。理由不明を意図的とは推測しない
      const stopKind = classifyAutoRepairStopReason(loop.stopReason);
      if (stopKind === "problem") categories.add("repair-stopped");
      return makeSlot("repair", {
        icon: stopKind === "intentional" ? "⏸" : stopKind === "waiting" ? "△" : "■",
        label: `自動修正停止 ${loop.round}/${loop.maxRounds}`,
        tone: stopKind === "intentional" ? "idle" : stopKind === "waiting" ? "wait" : "bad",
        title: `自動修正が止まりました: ${autoRepairStopReasonLabel(loop.stopReason)}`,
        href: null,
        detail: "pull-request",
      });
    }
    return null;
  }

  /** 修復系列が止まっているPRに、まだ直っていない問題が残っているか */
  function hasUnresolvedProblem(): boolean {
    return (
      categories.has("ci-failed") ||
      categories.has("conflict") ||
      categories.has("review-changes-requested") ||
      categories.has("review-needs-check") ||
      categories.has("review-failed")
    );
  }
}

export type PullRequestHealthCounts = Record<PullRequestHealthCategory, number>;

export const EMPTY_HEALTH_COUNTS: PullRequestHealthCounts = {
  "ci-failed": 0,
  "review-changes-requested": 0,
  "review-needs-check": 0,
  "review-failed": 0,
  conflict: 0,
  "ci-running": 0,
  "review-running": 0,
  "repair-fixing": 0,
  revalidating: 0,
  "repair-stopped": 0,
};

export type PullRequestHealthSummary = {
  /** カテゴリごとの該当open PR数。同じPRが複数に数えられるため、合計はPR数ではない */
  counts: PullRequestHealthCounts;
  /** 人の対応が要るopen PR数 */
  humanCount: number;
  /** 待てば進む（自動修正中・再検証待ち・CI／レビュー実行中）open PR数。`humanCount`とは重ならない */
  autoCount: number;
};

/** PR群からカテゴリ別の件数を数える。同じPR（`id`）は1回だけ数える */
export function summarizePullRequestHealth(
  pullRequests: readonly (HealthSource & { id: string })[],
): PullRequestHealthSummary {
  const counts: PullRequestHealthCounts = { ...EMPTY_HEALTH_COUNTS };
  let humanCount = 0;
  let autoCount = 0;
  const seen = new Set<string>();
  for (const pullRequest of pullRequests) {
    if (seen.has(pullRequest.id)) continue;
    seen.add(pullRequest.id);
    const health = resolvePullRequestHealth(pullRequest);
    for (const category of health.categories) counts[category] += 1;
    if (health.disposition === "human") humanCount += 1;
    else if (health.disposition === "auto") autoCount += 1;
  }
  return { counts, humanCount, autoCount };
}
