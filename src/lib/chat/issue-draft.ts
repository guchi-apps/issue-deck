import type { ChatTarget } from "@/lib/chat/types";

/** Issue案の本文。会話内容と確認していた対象を材料に、確認前に編集できる下書きを作る */
export function buildIssueDraft(params: {
  title: string | null;
  source: ChatTarget | null;
  recentUserTexts: string[];
}): { title: string; body: string } {
  const { source } = params;
  const title =
    params.title ?? (source ? `「${source.title}」の確認で出た別件の対応` : "会話で出た別件の対応");
  const lines: string[] = ["## 背景", ""];
  lines.push(
    source
      ? `IssueDeck Chatで #${source.number}（${source.title}）を確認している中で出た別件です。`
      : "IssueDeck Chatでの会話から起案しました。",
  );
  const texts = params.recentUserTexts.filter((text) => text.trim()).slice(-5);
  if (texts.length > 0) {
    lines.push("", "## 会話の内容", "", ...texts.map((text) => `- ${text.replace(/\n/g, " ")}`));
  }
  lines.push("", "## 完了条件", "", "- [ ] （確認して追記してください）");
  return { title: title.slice(0, 120), body: lines.join("\n") };
}
