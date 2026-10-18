import type { PublishProgressStage } from "@/lib/release-publish-approval";

/**
 * 公開承認のある新方式の候補（#4666）を、ブランチ画面の「次のリリース」カードの1行目で読める形にする（#4814）。
 *
 * **段階は承認の記録が導いた`progress`（`describePublishProgress`）だけから決め**、検証の合否から推測しない。
 * 承認済みで自動公開を待つ候補は、全体レビューが要確認の判断済みでも「失敗」には見せず進行中として出す。
 * 人の操作が要る段階（停止・失効・取消）だけを`bad`にする。承認の記録が無い（`needs_approval`）ときはnullを返し、
 * 画面は従来の検証ピルを出す。
 */
export type PublishStepState = "done" | "current" | "todo" | "stopped";

export type PublishStep = {
  key: "approved" | "bumped" | "merged" | "deploying" | "verifying" | "completed";
  label: string;
  state: PublishStepState;
  /** その段を終えた時刻（ISO）。承認・mainへのマージだけに入る */
  at: string | null;
};

export type PublishStepsView = {
  pill: { label: string; tone: "run" | "ok" | "bad" };
  steps: PublishStep[];
  /** mainへ入ったか。カードの補足の1行で使う */
  merged: boolean;
  /** 補足の1行（未マージなら待っている理由、止まっていれば理由）。無ければnull */
  note: string | null;
};

export type PublishStepsInput = {
  approval: {
    status: string;
    approvedAt: string;
    mergeSha: string | null;
    invalidMessage: string | null;
    progress: PublishProgressStage;
    progressLabel: string;
    run: { stopMessage: string | null; waitMessage?: string | null; mergedAt?: string | null } | null;
  } | null;
  /** 正式バンプの記録（`RcFinalizationView`）。無ければnull */
  finalization: { status: string } | null;
};

const ORDER: PublishStep["key"][] = ["approved", "bumped", "merged", "deploying", "verifying", "completed"];

/** 進行中の段階ごとの、いま居る段（その手前は済み） */
const CURRENT: Partial<Record<PublishProgressStage, PublishStep["key"]>> = {
  final_checks: "bumped",
  auto_publish: "merged",
  deploying: "deploying",
  verifying_production: "verifying",
};

/** 自動公開を待つ間のピル。`PUBLISH_PROGRESS_LABEL`の「自動公開待ち」は、何を待っているかを言わないので言い換える */
const AUTO_PUBLISH_PILL = "自動公開の条件を確認中";

export function describePublishSteps(input: PublishStepsInput): PublishStepsView | null {
  const { approval, finalization } = input;
  if (!approval || approval.progress === "needs_approval") return null;
  const progress = approval.progress;
  const bumped = finalization?.status === "applied";
  const mergedAt = approval.run?.mergedAt ?? null;
  // 本番反映中以降は、記録上mainへ入っている（承認の`merging`は確保中で、マージSHAが付くまでは未マージ）
  const merged =
    approval.mergeSha !== null ||
    mergedAt !== null ||
    progress === "verifying_production" ||
    progress === "completed" ||
    (progress === "deploying" && approval.status !== "merging");

  const stopped = progress === "stopped" || progress === "invalidated" || progress === "revoked";
  let current: PublishStep["key"] | null;
  if (progress === "completed") current = null;
  else if (stopped) current = !bumped ? "bumped" : !merged ? "merged" : "deploying";
  else if (progress === "deploying" && !merged) current = "merged";
  else current = CURRENT[progress] ?? "bumped";
  const currentIndex = current === null ? ORDER.length : ORDER.indexOf(current);

  const labelOf = (key: PublishStep["key"], state: PublishStepState): string => {
    switch (key) {
      case "approved":
        return "承認済み";
      case "bumped":
        return state === "done" ? "バンプ済み" : "正式バンプ・最終検証";
      case "merged":
        return state === "done" ? "mainへマージ済み" : progress === "deploying" ? "mainへマージ中" : "mainへマージ待ち";
      case "deploying":
        return "本番反映";
      case "verifying":
        return "稼働確認";
      case "completed":
        return "完了";
    }
  };
  const steps = ORDER.map((key, index): PublishStep => {
    const state: PublishStepState =
      progress === "completed" || index < currentIndex ? "done" : index === currentIndex ? (stopped ? "stopped" : "current") : "todo";
    const at = state !== "done" ? null : key === "approved" ? approval.approvedAt : key === "merged" ? mergedAt : null;
    return { key, label: labelOf(key, state), state, at };
  });

  const pill: PublishStepsView["pill"] = stopped
    ? { label: approval.progressLabel, tone: "bad" }
    : progress === "completed"
      ? { label: approval.progressLabel, tone: "ok" }
      : progress === "auto_publish"
        ? { label: AUTO_PUBLISH_PILL, tone: "run" }
        : progress === "deploying" && !merged
          ? { label: "mainへマージ中", tone: "run" }
          : { label: approval.progressLabel, tone: "run" };

  const note = stopped
    ? (progress === "stopped" ? approval.run?.stopMessage : approval.invalidMessage) ?? null
    : !merged
      ? progress === "auto_publish"
        ? `mainへは未マージです。条件が揃うと自動でマージします${approval.run?.waitMessage ? `（${approval.run.waitMessage}）` : ""}`
        : "mainへは未マージです"
      : null;

  return { pill, steps, merged, note };
}
