/**
 * 「Claudeレビューの実行条件」から起案する、条件変更Issueの下書き。
 *
 * **ここでは起票しない。** 現在の条件と直近の実行状況を埋めた新規作成ダイアログを開くための
 * 下書きを作るだけで、何をどう変えるかは読んだ人が書く（`buildPullRequestFixIssueDraft`・#2961と同じ立場）。
 * 材料は画面がすでに取得している`ReviewGateRepository`だけで、追加のAPI呼び出しはしない。
 */

import type { ReviewGateRepository } from "@/lib/github/review-gates";
import { summarizeReviewOutcomes, type RiskPathsState } from "@/lib/review-gate-config";

export type ReviewGateIssueDraft = {
  repositoryFullName: string;
  title: string;
  body: string;
};

const RISK_PATHS_LABEL: Record<RiskPathsState, string> = {
  template: "雛形のまま",
  custom: "雛形＋固有の行",
  replaced: "固有の行のみ（雛形の行が欠けている）",
  none: "指定なし（内蔵パターンのみ）",
  unknown: "雛形と比較できず",
};

export function buildReviewGateIssueDraft(repository: ReviewGateRepository): ReviewGateIssueDraft {
  const { config } = repository;
  const { inputs } = config;
  const summary = summarizeReviewOutcomes(repository.outcomes);

  const outcomeLine = !repository.outcomesAvailable
    ? "取得できませんでした"
    : repository.outcomes.length === 0
      ? "Issue PRなし"
      : `直近${repository.outcomes.length}件のIssue PRのうち、レビュー実行${summary.reviewed}件 / skip${summary.skipped}件` +
        (summary.errors > 0 ? ` / 判定エラー${summary.errors}件` : "");

  const body = [
    "## 現在の条件",
    "",
    `- caller: ${repository.callerUrl}`,
    `- 閾値: ${inputs["review-file-threshold"].value}ファイル / ${inputs["review-line-threshold"].value}行`,
    `- merge-policy: ${inputs["merge-policy"].value}`,
    `- dependency-check: ${inputs["dependency-check"].value}`,
    `- risk-paths: ${RISK_PATHS_LABEL[config.riskPathsState]}（${config.riskPaths.length}件）`,
    `- 直近の実行状況: ${outcomeLine}`,
    "",
    "## 変更したい内容",
    "",
    "（例: 閾値を5ファイル / 200行へ下げる、認証まわりのパスをrisk-pathsへ足す）",
    "",
    "## 変更したい理由",
    "",
  ].join("\n");

  return {
    repositoryFullName: repository.fullName,
    title: "Claudeレビューの実行条件を変更する",
    body,
  };
}
