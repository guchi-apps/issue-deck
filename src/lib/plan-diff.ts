/**
 * 計画を出し直したとき、前回の計画からの追加・変更行を見つけて`<ins>`で包む（#5504）。
 *
 * 行単位の比較で、前回に同じ行（前後の空白・リストの印を除いた本文）が無い行を「追加・変更」とみなす。
 * 削除された行は本文に出さない。表の行・コードブロック・区切り線・見出しの`#`は壊れやすいので
 * 包む対象にしない（表・コードは丸ごと対象外、見出し・リストは印の後ろの本文だけを包む）。
 */

export type MarkedPlan = {
  markdown: string;
  /** 追加・変更として強調した行数 */
  changedCount: number;
};

const FENCE = /^\s*(```|~~~)/;
const PREFIX = /^(\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?))?/;

function normalize(line: string): string {
  return line.replace(PREFIX, "").replace(/\s+/g, " ").trim();
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

function isPlainSkippable(line: string): boolean {
  const t = line.trim();
  return t === "" || /^([-*_])\1{2,}$/.test(t) || /^<!--.*-->$/.test(t);
}

export function markPlanChanges(previous: string | null | undefined, current: string): MarkedPlan {
  if (!previous || previous.trim() === "") return { markdown: current, changedCount: 0 };

  const known = new Map<string, number>();
  for (const line of previous.split("\n")) {
    const key = normalize(line);
    if (key !== "") known.set(key, (known.get(key) ?? 0) + 1);
  }

  let inFence = false;
  let changedCount = 0;
  const out = current.split("\n").map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || isTableLine(line) || isPlainSkippable(line)) return line;

    const key = normalize(line);
    if (key === "") return line;
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      return line;
    }
    changedCount += 1;
    const prefix = PREFIX.exec(line)?.[0] ?? "";
    const body = line.slice(prefix.length);
    return `${prefix}<ins>${body}</ins>`;
  });

  return { markdown: out.join("\n"), changedCount };
}
