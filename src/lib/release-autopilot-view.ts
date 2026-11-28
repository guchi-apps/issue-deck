/**
 * 本番公開の全自動の画面表示（#公開の全自動）。**状態・文言・出してよい操作をここ1か所で決める**
 * （本番PR詳細とスマホのリリースシートが同じ結果を使う。部品ごとに条件を書くと手動操作が漏れて出る）。
 */
import type { AutopilotStopReason } from "@/lib/release-autopilot";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

export type AutoPublishViewInput = {
  phase: string;
  autoPublish: { active: boolean; stopCode: string | null; stopReason: string | null } | null | undefined;
  /** 修正の取り込みなど、未完了の更新要求がある */
  importing: boolean;
  /** 本番の稼働確認が止まっている */
  productionStopped: boolean;
  verification: ReleaseVerificationSummary | null;
};

export type AutoPublishStepState = "done" | "current" | "failed" | "todo";

export type AutoPublishView = {
  mode: "running" | "stopped" | "completed";
  headline: string;
  note: string;
  steps: { label: string; state: AutoPublishStepState; details: { label: string; value: string }[] }[];
  /** 手動の操作を画面に出さないか（mainマージ前に自動で動いている間） */
  hideManual: boolean;
  canStop: boolean;
  /** 停止中の再開。できなければnull。`rerun`は再開の前にやり直す検証 */
  resume: { label: string; rerun: "integration" | "review" | null } | null;
};

export const AUTO_PUBLISH_STEPS = ["候補を作成", "検証と修正", "最終検証", "mainマージ", "本番反映", "稼働確認"] as const;

const STEP_OF_PHASE: Record<string, number> = {
  creating: 0,
  review: 1,
  preparing: 2,
  awaiting_approval: 3,
  deploying: 4,
  verifying_production: 5,
  completed: AUTO_PUBLISH_STEPS.length,
};

const CHECK_VALUE: Record<string, string> = {
  passed: "合格",
  failed: "失敗",
  needs_check: "指摘あり",
  not_applicable: "対象外",
  running: "実行中",
};

const STOP_HEADLINE: Record<AutopilotStopReason, string> = {
  expired: "24時間以内に公開できませんでした",
  run_stopped: "自動の修正・公開が止まりました",
  approval_ended: "公開承認が失効しました",
  human_check_label: "人の確認が必要です",
  integration_environment: "統合検証を実行できませんでした",
  review_unverified: "全体レビューで確認できない範囲が残りました",
  recommendations_unavailable: "判断できない指摘があります",
  approval_failed: "公開へ進めませんでした",
  main_advanced: "mainが先に進みました",
  stopped_by_user: "自動公開を止めました",
};

function resumeOf(code: string | null): AutoPublishView["resume"] {
  if (code === "main_advanced") return null;
  if (code === "integration_environment") return { label: "再実行して自動公開を再開する", rerun: "integration" };
  if (code === "review_unverified") return { label: "再実行して自動公開を再開する", rerun: "review" };
  return { label: "自動公開を再開する", rerun: null };
}

function verificationDetails(verification: ReleaseVerificationSummary | null): { label: string; value: string }[] {
  if (!verification) return [];
  const value = (state: string) => CHECK_VALUE[state] ?? "待機中";
  const findings = verification.aiReview.findings.length;
  return [
    { label: "統合検証", value: value(verification.integration.state) },
    {
      label: "全体レビュー",
      value: verification.aiReview.state === "needs_check" && findings > 0 ? `指摘${findings}件` : value(verification.aiReview.state),
    },
  ];
}

/** 全自動の対象でない候補・取り消した候補はnull（従来の表示を使う） */
export function describeAutoPublishView(input: AutoPublishViewInput): AutoPublishView | null {
  const auto = input.autoPublish;
  const index = STEP_OF_PHASE[input.phase];
  if (!auto || index === undefined) return null;
  const preMerge = index <= 3;
  const completed = input.phase === "completed";
  // mainへ入った後は、全自動の停止ではなく本番反映の記録（稼働確認の停止）で表す
  const stopped = !completed && ((preMerge && !auto.active) || input.productionStopped);
  const details = input.phase === "review" ? verificationDetails(input.verification) : [];
  const steps = AUTO_PUBLISH_STEPS.map((label, i) => ({
    label,
    state: (i < index ? "done" : i === index ? (stopped ? "failed" : "current") : "todo") as AutoPublishStepState,
    details: i === index ? details : [],
  }));
  if (completed) {
    return { mode: "completed", headline: "本番公開が完了しました", note: "本番の稼働を確かめました。", steps, hideManual: false, canStop: false, resume: null };
  }
  if (stopped) {
    const code = preMerge ? auto.stopCode : null;
    return {
      mode: "stopped",
      headline: preMerge ? (STOP_HEADLINE[code as AutopilotStopReason] ?? "自動公開を停止しました") : "稼働確認が止まっています",
      note: preMerge
        ? [auto.stopReason, code === "main_advanced" ? "候補を取り消して作り直してください。" : null].filter(Boolean).join(" ")
        : "下の公開準備の欄で原因を確かめて、確認をやり直してください。",
      steps,
      hideManual: false,
      canStop: false,
      resume: preMerge ? resumeOf(code) : null,
    };
  }
  const findings = input.verification?.aiReview.state === "needs_check" ? input.verification.aiReview.findings.length : 0;
  const [headline, note] =
    input.phase === "creating"
      ? ["候補を作成しています", "操作は不要です。作成できると検証が始まります。"]
      : input.phase === "review"
        ? input.importing
          ? ["修正を候補へ取り込んでいます", "操作は不要です。取り込むと再検証します。"]
          : findings > 0
            ? [`指摘${findings}件を修正しています`, "操作は不要です。再検証に合格すると、そのまま本番へ公開します。"]
            : ["候補を検証しています", "操作は不要です。合格すると、そのまま本番へ公開します。"]
        : input.phase === "preparing"
          ? ["最終検証をしています", "操作は不要です。合格するとmainへマージします。"]
          : input.phase === "awaiting_approval"
            ? ["mainへマージします", "操作は不要です。条件が揃うとマージします。"]
            : input.phase === "deploying"
              ? ["本番へ反映しています", "操作は不要です。反映後に稼働を確かめます。"]
              : ["本番の稼働を確認しています", "操作は不要です。"];
  return { mode: "running", headline, note, steps, hideManual: preMerge, canStop: preMerge, resume: null };
}
