import {
  ISSUE_ORDER_BODY_HEAD_LENGTH,
  ISSUE_ORDER_CANDIDATE_LIMIT,
} from "@/lib/claude/limits";
import { callClaudeMessages } from "@/lib/claude/request";

/** 着手順の判定に使うモデル。`issue-search.ts`と同じくプラン枠の消費を抑える軽量なもの。 */


/** 着手順として返させるIssueの上限。これ以上並べても、上から順に着手する用途では読まれない。 */
export const ISSUE_ORDER_RESULT_LIMIT = 5;

/** 「実施しない方がよい」として返させるIssueの上限。 */
export const ISSUE_ORDER_SKIP_LIMIT = 5;


/** 全体の方針（`overview`）として受け取る文字数の上限。 */
const MAX_OVERVIEW_LENGTH = 300;

/** 1件ごとの理由（`reason`）として受け取る文字数の上限。 */
const MAX_REASON_LENGTH = 200;

/**
 * 判定材料として渡すIssue1件。
 *
 * `key`は`owner/repo#123`形式で、応答を突き合わせるときの識別子になる
 * （`issue-search.ts`と同じ。Issueのidは長いノードIDで、プロンプトに載せるだけ枠を消費する）。
 *
 * **本文は`bodyHead`（先頭`ISSUE_ORDER_BODY_HEAD_LENGTH`文字）だけを載せる。** 着手順は
 * 「何をするIssueか」と「他のIssueの前提になっているか」で決まるため、タイトルとラベルだけでは
 * 材料が足りない。一方で全文を載せると候補60件で入力が数十万文字になる。
 */
export type IssueOrderCandidate = {
  key: string;
  title: string;
  labels: string[];
  /** 起票からの経過日数。古さは「陳腐化していないか」の手がかりになる */
  ageDays: number;
  bodyHead: string;
};

export type IssueOrderInput = {
  candidates: IssueOrderCandidate[];
};

/** 着手順・見送り候補に共通する1件ぶんの判定結果。 */
export type IssueOrderItem = {
  key: string;
  reason: string;
};

export type IssueOrderResult = {
  /** 全体の方針（1〜2文）。読めなければ空文字 */
  overview: string;
  /** 着手すべき順に並んだIssue */
  order: IssueOrderItem[];
  /** 実施しない方がよいと判断されたIssue */
  skip: IssueOrderItem[];
};

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...(省略)`;
}

/** 候補Issueから、着手順と見送り候補を決めさせるプロンプトを組み立てる。 */
export function buildIssueOrderPrompt(input: IssueOrderInput): string {
  const candidatesText = input.candidates
    .map((candidate) => {
      const labels = candidate.labels.length > 0 ? ` [${candidate.labels.join(", ")}]` : "";
      const body = candidate.bodyHead.trim()
        ? `\n  ${truncate(candidate.bodyHead, ISSUE_ORDER_BODY_HEAD_LENGTH)}`
        : "";
      return `- ${candidate.key} ${candidate.title}${labels} (起票から${candidate.ageDays}日)${body}`;
    })
    .join("\n");

  return `以下は、複数のGitHubリポジトリで未着手になっているIssueの一覧です。これから実装作業を始める人のために、**着手する順番**を決めてください。あわせて、**実施しない方がよいと考えられるIssue**があれば挙げてください。

# 着手順の決め方

次の観点で判断し、確からしい順に最大${ISSUE_ORDER_RESULT_LIMIT}件挙げてください。上にあるものほど重視します。

1. **他のIssueの前提になっているもの**を先にする。共通化・基盤・データ構造の変更など、後から入れると他のIssueが手戻りになるもの
2. **優先度ラベル**（\`80.Priority: High\`は先へ、\`89.Priority: low\`は後ろへ）
3. **壊れているものを直す**（\`30.bug\`・\`40.unexpected\`）。日常的に使う機能が壊れているものほど先
4. **短時間で終わるもの**を挟み、未着手が滞留しないようにする
5. 同じファイル・同じ領域を触るIssueは**連続させる**（並行して実装すると衝突するため）

# 実施しない方がよいIssueの挙げ方

次のどちらかに当てはまるものを最大${ISSUE_ORDER_SKIP_LIMIT}件挙げてください。**当てはまるものが無ければ空配列にしてください**（無理に挙げない）。

- 他のIssueと内容が重複しており、どちらか一方に寄せた方がよいもの
- 起票から時間が経っており、その後の変更で前提が変わって不要になっている可能性が高いもの

判断は推測でしかなく、クローズするかどうかは人が決めます。**断定せず、そう考えた理由を書いてください。**

# 出力

前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。

{"overview": "全体の方針を1〜2文", "order": [{"key": "owner/name#12", "reason": "この順番にした理由"}], "skip": [{"key": "owner/name#34", "reason": "実施しない方がよいと考えた理由"}]}

- \`key\`は「候補Issue一覧」に存在するもの（行頭の\`owner/name#番号\`）のみを使ってください
- \`reason\`は日本語で1〜2文。「なぜその順なのか」「なぜ見送るのか」が読み手に伝わるように書いてください
- 同じIssueを\`order\`と\`skip\`の両方に入れないでください

# 候補Issue一覧
${candidatesText}`;
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * 応答の配列から、候補に実在するキーの項目だけを順序どおりに取り出す。
 *
 * `used`は`order`と`skip`をまたいで共有する。同じIssueが両方に出てきた場合、先に読んだ
 * （＝着手順の）方だけを残す——「1位に挙がっているのに実施しない方がよい」という結果を
 * そのまま画面に出しても、押した人はどちらに従えばよいのか判断できない。
 */
function pickItems(
  value: unknown,
  byLowerKey: Map<string, string>,
  used: Set<string>,
  limit: number,
): IssueOrderItem[] {
  if (!Array.isArray(value)) return [];

  const picked: IssueOrderItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, reason } = entry as { key?: unknown; reason?: unknown };
    if (typeof key !== "string") continue;

    const matched = byLowerKey.get(key.trim().toLowerCase());
    if (!matched || used.has(matched)) continue;

    used.add(matched);
    picked.push({
      key: matched,
      reason: typeof reason === "string" ? truncate(reason, MAX_REASON_LENGTH) : "",
    });
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Claudeの応答テキストから、着手順と見送り候補を取り出す。
 *
 * **候補に無いキーは採らない**（`issue-search.ts`の`pickMatchedIssueKeys`と同じ方針）。
 * 存在しないIssueをそのまま画面へ出すと、押しても開けない行が並ぶ。JSONとして読めない応答も
 * 同様に空の結果へ倒す（呼び出し側は「決められなかった」として扱う）。
 */
export function pickIssueOrder(text: string, candidateKeys: string[]): IssueOrderResult {
  const empty: IssueOrderResult = { overview: "", order: [], skip: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;

  const { overview, order, skip } = parsed as {
    overview?: unknown;
    order?: unknown;
    skip?: unknown;
  };

  const byLowerKey = new Map(candidateKeys.map((key) => [key.toLowerCase(), key]));
  const used = new Set<string>();

  return {
    overview: typeof overview === "string" ? truncate(overview, MAX_OVERVIEW_LENGTH) : "",
    order: pickItems(order, byLowerKey, used, ISSUE_ORDER_RESULT_LIMIT),
    skip: pickItems(skip, byLowerKey, used, ISSUE_ORDER_SKIP_LIMIT),
  };
}

/**
 * 未着手のIssueをClaudeに読ませ、着手順と「実施しない方がよいもの」を返す（#1853）。
 *
 * `issue-search.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を呼び出す（送信は`request.ts`が担う）。**呼び出しごとにプラン枠を消費するため、ボタンを押したときだけ
 * 呼ぶ**（画面側の`use-issue-order.ts`も一覧を開いた時点では呼ばない）。
 *
 * 候補が0件ならClaudeを呼ばない（決める対象が無く、枠を消費するだけのため）。
 */
export async function decideIssueOrder(
  token: string,
  input: IssueOrderInput,
): Promise<IssueOrderResult> {
  const candidates = input.candidates.slice(0, ISSUE_ORDER_CANDIDATE_LIMIT);
  if (candidates.length === 0) return { overview: "", order: [], skip: [] };

  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "issue_order",
    token,
    body: {
      max_tokens: 2048,
      messages: [{ role: "user", content: buildIssueOrderPrompt({ candidates }) }],
    },
  });

  if (!res.ok) {
    throw new Error(`Claudeによる着手順の判定に失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) return { overview: "", order: [], skip: [] };

  return pickIssueOrder(
    text,
    candidates.map((candidate) => candidate.key),
  );
}
