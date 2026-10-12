import type { EpicDraft, EpicOutcome, EpicStage } from "@/lib/epic-draft/types";

const STAGE_LABEL: Record<EpicStage, string> = {
  reconcile: "既存Issueの照合",
  parent: "親Issueの作成",
  children: "子Issueの作成",
  link: "GitHubの親子関係の紐付け",
  plan: "実行計画の登録",
  body: "親Issue本文の更新",
};

const link = (repo: string, number: number) => `<https://github.com/${repo}/issues/${number}|${repo}#${number}>`;

/**
 * Slackの完了報告。**保存済みの案と作成結果だけから組み立てる**ので、再送でも同じ内容になる。
 * 子は自動では始まらないこと、親から実行を開始することを必ず添える。
 */
export function epicDoneText(draft: EpicDraft, outcome: Extract<EpicOutcome, { ok: true }>): string {
  const parent = outcome.progress.parent!;
  const lines = [
    `✅ 親子Issueとして起案しました（実行計画 v${outcome.planVersion}）。`,
    `• 親: ${link(parent.repo, parent.number)} ${draft.parent.title}`,
    "• 実行順序:",
  ];
  outcome.stages.forEach((keys, i) => {
    const parallel = keys.length > 1 ? "（並行可）" : "";
    const items = keys.map((key) => {
      const c = draft.children.find((x) => x.key === key)!;
      const r = outcome.progress.children[key]!;
      const deps = c.dependsOn
        .map((d) => {
          const t = outcome.progress.children[d.key];
          return t ? `${t.repo}#${t.number}が${d.conditions.join("・")}` : "";
        })
        .filter(Boolean);
      return `${link(r.repo, r.number)} ${c.title}${r.reused ? "（既存を再利用）" : ""}${deps.length ? `［進む条件: ${deps.join("、")}］` : ""}`;
    });
    lines.push(`  ${i + 1}. ${parallel}${items.join(" ／ ")}`);
  });
  lines.push(`子は自動では実装を開始しません。IssueDeckで親 ${link(parent.repo, parent.number)} を開き、親の実行を開始してください。`);
  lines.push("同じスレッドへ補足を返信すると、親Issueへコメントとして追記します（実行計画の対象は黙って増やしません）。");
  return lines.join("\n");
}

/** 途中で止まったときの報告。完了とは言わず、作成済みの範囲・止まった段階・再開方法を示す */
export function epicFailureText(outcome: Extract<EpicOutcome, { ok: false }>): string {
  const { progress } = outcome;
  const made: string[] = [];
  if (progress.parent) made.push(`親 ${link(progress.parent.repo, progress.parent.number)}`);
  const children = Object.values(progress.children).filter((c): c is NonNullable<typeof c> => !!c);
  if (children.length) made.push(`子${children.length}件（${children.map((c) => link(c.repo, c.number)).join("、")}）`);
  return [
    `⚠️ 親子Issueの起案は完了していません。止まった段階: ${STAGE_LABEL[outcome.stage]}（${outcome.message.slice(0, 200)}）`,
    `• 作成済み: ${made.length ? made.join("、") : "なし"}`,
    "• 未完了: 残りの子・親子の紐付け・実行計画の登録のうち、上の段階以降",
    "• 再開: このスレッドへ「再開」と返信してください。作成済みのIssueは作り直さず、不足分だけ続けます。",
  ].join("\n");
}
