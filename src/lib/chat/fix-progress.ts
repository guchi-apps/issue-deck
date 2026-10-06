import type { ChatFixProgressCard } from "@/lib/chat/types";

/**
 * 修正依頼（チャットから渡したもの）の進み具合を、いまのPRの状態から決める（#4045）。
 *
 * 状態は保存せず**取得のたびに導く**——画面を閉じても、再接続しても、同じ入力から同じ答えになる。
 * 「CI／レビュー待ち」は完了にしない。**検証済みと言えるのは、依頼後にHEADが進み、そのHEADのCIが
 * 成功し、そのHEADに対する自動レビューが通っているときだけ**（古い判定で完了と言わない）。
 */

export type FixProgressInput = {
  repo: string;
  number: number;
  requestedHeadSha: string;
  pr: { state: "open" | "closed"; merged: boolean; headSha: string; htmlUrl: string | null };
  ciState: "pending" | "success" | "failure" | "unknown";
  activeRepair: boolean;
  /** 依頼後に、実行系が投稿した報告コメントがあるか */
  agentReported: boolean;
  verdict: { reviewKind: string; reviewedSha: string | null } | null;
  fetchedAt: string;
};

function sameSha(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.startsWith(b.slice(0, 7)) || b.startsWith(a.slice(0, 7));
}

export function computeFixProgress(input: FixProgressInput): ChatFixProgressCard {
  const moved = input.pr.headSha !== input.requestedHeadSha;
  const reviewAtHead = input.verdict !== null && sameSha(input.verdict.reviewedSha, input.pr.headSha);
  const reviewOk = reviewAtHead && input.verdict?.reviewKind === "ok";
  const reviewBad =
    reviewAtHead && (input.verdict?.reviewKind === "changes-requested" || input.verdict?.reviewKind === "needs-check");

  const steps: ChatFixProgressCard["steps"] = [
    { label: "依頼を渡した", done: true, note: `HEAD ${input.requestedHeadSha.slice(0, 7)}` },
    {
      label: "修正をpushした",
      done: moved,
      note: moved ? `新HEAD ${input.pr.headSha.slice(0, 7)}` : input.activeRepair ? "実行中" : "未着手（実行先の起動待ち）",
    },
    {
      label: "CIが成功した",
      done: moved && input.ciState === "success",
      note: !moved ? null : input.ciState === "success" ? null : input.ciState === "failure" ? "失敗" : input.ciState === "pending" ? "実行中" : "不明",
    },
    {
      label: "自動レビューが通った",
      done: moved && reviewOk,
      note: !moved ? null : reviewOk ? null : reviewBad ? "未解消の指摘あり" : "新HEADへの判定待ち",
    },
  ];

  let phase: ChatFixProgressCard["phase"];
  let phaseLabel: string;
  if (input.pr.merged || input.pr.state === "closed") {
    phase = "failed";
    phaseLabel = input.pr.merged ? "PRはマージ済みです（この依頼の検証は対象外）" : "PRがクローズされました";
  } else if (!moved) {
    phase = input.activeRepair || input.agentReported ? "working" : "requested";
    phaseLabel = phase === "working" ? "実行中（まだpushされていません）" : "依頼済み・実行待ち";
  } else if (input.ciState === "failure") {
    phase = "failed";
    phaseLabel = "修正後のCIが失敗しています";
  } else if (reviewBad) {
    phase = "failed";
    phaseLabel = "レビューで未解消の指摘が残っています";
  } else if (input.ciState === "success" && reviewOk) {
    phase = "verified";
    phaseLabel = "検証済み（新HEADのCI成功・自動レビュー通過）";
  } else if (input.ciState !== "success") {
    phase = "waiting_ci";
    phaseLabel = "CI待ち（完了ではありません）";
  } else {
    phase = "waiting_review";
    phaseLabel = "レビュー待ち（完了ではありません）";
  }

  return {
    type: "fix_progress",
    repo: input.repo,
    number: input.number,
    phase,
    phaseLabel,
    headSha: input.pr.headSha,
    requestedHeadSha: input.requestedHeadSha,
    steps,
    htmlUrl: input.pr.htmlUrl,
    fetchedAt: input.fetchedAt,
  };
}
