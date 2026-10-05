import type {
  ChatActionRecord,
  ChatContext,
  ChatFinding,
  ChatMemory,
  ChatMemoryItem,
  ChatStatusCard,
  ChatStatusRow,
} from "@/lib/chat/types";
import { EMPTY_CHAT_MEMORY } from "@/lib/chat/types";

/** 会話メモ・調査結果の保持上限（長い会話でも1行のJSONが膨らみ続けないようにする） */
export const MAX_MEMORY_ITEMS = 30;
export const MAX_FINDINGS = 20;
export const MAX_MEMORY_TEXT = 300;

function parseItems(value: unknown): ChatMemoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Partial<ChatMemoryItem>;
    if (typeof raw.id !== "string" || typeof raw.text !== "string") return [];
    return [
      {
        id: raw.id,
        text: raw.text,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
        ...(typeof raw.resolvedAt === "string" ? { resolvedAt: raw.resolvedAt } : {}),
      },
    ];
  });
}

export function parseChatMemory(value: unknown): ChatMemory {
  if (!value || typeof value !== "object") return EMPTY_CHAT_MEMORY;
  const raw = value as Partial<ChatMemory>;
  return {
    agreements: parseItems(raw.agreements),
    openQuestions: parseItems(raw.openQuestions),
    findings: Array.isArray(raw.findings) ? (raw.findings as ChatFinding[]) : [],
  };
}

export type ChatMemoryOp =
  | { op: "add"; kind: "agreement" | "openQuestion"; text: string }
  | { op: "remove"; kind: "agreement" | "openQuestion"; id: string }
  | { op: "resolve"; id: string };

/** 操作を検証して適用する。不正な操作・存在しないIDは`null`（呼び出し側が400にする） */
export function applyMemoryOp(
  memory: ChatMemory,
  op: ChatMemoryOp,
  now: Date,
  newId: () => string,
): ChatMemory | null {
  if (op.op === "add") {
    const text = op.text.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_TEXT);
    if (!text) return null;
    const item: ChatMemoryItem = { id: newId(), text, createdAt: now.toISOString() };
    const key = op.kind === "agreement" ? "agreements" : "openQuestions";
    return { ...memory, [key]: [...memory[key], item].slice(-MAX_MEMORY_ITEMS) };
  }
  if (op.op === "remove") {
    const key = op.kind === "agreement" ? "agreements" : "openQuestions";
    if (!memory[key].some((item) => item.id === op.id)) return null;
    return { ...memory, [key]: memory[key].filter((item) => item.id !== op.id) };
  }
  if (!memory.openQuestions.some((item) => item.id === op.id)) return null;
  return {
    ...memory,
    openQuestions: memory.openQuestions.map((item) =>
      item.id === op.id ? { ...item, resolvedAt: now.toISOString() } : item,
    ),
  };
}

/** 状態カードを調査結果として残す。同じ対象は最新で置き換える */
export function recordFindings(memory: ChatMemory, cards: ChatStatusCard[], now: Date): ChatMemory {
  if (cards.length === 0) return memory;
  const captured: ChatFinding[] = cards.map((card) => ({
    repo: card.repo,
    number: card.number,
    kind: card.kind,
    title: card.title,
    htmlUrl: card.htmlUrl,
    capturedAt: now.toISOString(),
    rows: card.rows,
  }));
  const keys = new Set(captured.map((f) => `${f.repo}#${f.number}`));
  const kept = memory.findings.filter((f) => !keys.has(`${f.repo}#${f.number}`));
  return { ...memory, findings: [...kept, ...captured].slice(-MAX_FINDINGS) };
}

/** 調査時点の行と、いま再取得した行の差（ラベルが同じで値が違うものだけ） */
export function diffRows(before: ChatStatusRow[], after: ChatStatusRow[]) {
  return after.flatMap((row) => {
    const prev = before.find((item) => item.label === row.label);
    return prev && prev.value !== row.value
      ? [{ label: row.label, before: prev.value, after: row.value }]
      : [];
  });
}

const NUMBER_PATTERN = /(?:^|[^\w/])#?(\d{1,6})(?!\w)/g;

/** 検索用の「owner/repo#番号 」の連結。対象・実行記録・発言に出た番号から作る */
export function buildRefsText(
  context: ChatContext,
  extraTexts: string[],
  previous = "",
): string {
  const tokens = new Set(previous.split(" ").filter(Boolean));
  const fallbackRepo = context.repo ?? "";
  for (const target of context.targets) tokens.add(`${target.repo}#${target.number}`);
  for (const action of context.actions as ChatActionRecord[]) {
    if (action.number != null) tokens.add(`${action.repo}#${action.number}`);
  }
  for (const text of extraTexts) {
    for (const match of text.matchAll(NUMBER_PATTERN)) tokens.add(`${fallbackRepo}#${match[1]}`);
  }
  // 古いものから落とす（列が際限なく伸びないように）
  return [...tokens].slice(-200).map((token) => `${token} `).join("");
}

/** 一覧の検索語。`#3966`・`3966`は番号検索、それ以外はタイトル・本文の部分一致 */
export function parseSearchQuery(raw: string): { text: string; number: number | null } {
  const text = raw.trim().slice(0, 100);
  const numeric = /^#?(\d{1,6})$/.exec(text);
  return { text, number: numeric ? Number(numeric[1]) : null };
}
