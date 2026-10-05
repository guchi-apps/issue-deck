import { callClaudeMessages } from "@/lib/claude/request";

/**
 * 手作業Issueの本文を、雛形（`docs/multi-agent/manual-step-body-template.md`）へ直す（#4039）。
 *
 * **出すのは整形後の本文だけで、適用するかどうかは呼び出し側（`lib/manual-step-normalize.ts`）が
 * 決める。** ここでAIが返した本文をそのまま信用しない——コマンドが書き換わっていないことを
 * 呼び出し側が検証する。
 */

/** 長大な本文は整形の対象にしない（切り詰めると欠けた本文を書き戻すことになる） */
export const MANUAL_STEP_NORMALIZE_BODY_MAX_LENGTH = 12_000;

/** 応答を待つ上限。自動実行の開始（画面の操作）から同期で呼ばれるため必ず指定する */
export const MANUAL_STEP_NORMALIZE_TIMEOUT_MS = 60_000;

const MAX_TOKENS = 8192;

const TEMPLATE = `## この作業でできるようになること

- できるようになること: （実行すると何が使える・動くようになるか）
- 実行するまでできないこと: （それまで何が止まる・使えないか）
- 急ぎ具合: （いつまでに必要か。急がないなら「急がない」）

## 前提条件

- 実行するデバイス: （サブPC / メインPC / VPS / ブラウザ のどれか1つ）
- カレントディレクトリ: （\`cd\`する場所。不要なら「不要」）
- Gitブランチ: （原則\`develop\`。不要なら「不要」）
- 先に完了している必要があるIssue・PR: （\`#<番号>\`。無ければ「なし」）
- その他の前提: （無ければ「なし」）

## やること

- [ ] （サブPC）1手順目。何をするかを1行で

  \`\`\`bash
  （その手順で実行するコマンド）
  \`\`\`

- [ ] （ブラウザ）2手順目

## 完了の確認方法

- （1手順目が効いたことの確認。何を確かめるかを1行で）

  \`\`\`bash
  （確かめるコマンド）
  \`\`\`

  （期待する出力）

## なぜエージェントが実施しないか

（理由）

## 関連

- 起点Issue: #<番号>
- 対応PR: #<番号>`;

export function buildManualStepNormalizePrompt(params: {
  title: string;
  body: string;
  findings: string[];
}): string {
  return `以下はGitHubの「手作業Issue」の本文です。画面の解析器が読めるよう、次の雛形の見出し・項目・書式へ整形し直してください。

# 雛形
${TEMPLATE}

# 守ること
- **コードブロック（コマンド）の中身は1文字も変えない。** 追加・削除・並べ替え・修正をしない。コマンドの数も同じにする
- 手順の文頭のデバイス表記（\`（サブPC）\`など）は、本文に書かれている端末だけを使う。書かれていない端末を推測で付けない。\`前提条件\`の値も、本文から読み取れるものだけを書く（読み取れない項目は「不要」「なし」とせず、元の文章を残すか空欄にしない範囲で最小限に埋める）
- 1つの手順のコードブロックはちょうど1つ。手順は\`- [ ]\`のチェックリストにし、コマンドのコードブロックはその項目の2スペース下げで置く。元のチェック状態（\`[x]\`）は保つ
- 本文にある情報を落とさない。雛形のどこにも当てはまらない文章は、最も近い節へ移す
- 関連Issue・PRは\`#<番号>\`（別リポジトリは\`owner/repo#<番号>\`）で書く。URLで書かれていれば直す
- 検査で見つかった指摘をすべて解消する

# 検査の指摘
${params.findings.map((finding) => `- ${finding}`).join("\n")}

# Issueのタイトル
${params.title}

出力は前置き・説明・全体を囲むコードフェンスを一切付けず、整形後の本文のみとしてください。

# 本文
${params.body}`;
}

type MessageResponse = { content?: { type: string; text?: string }[] };

/** 整形後の本文を返す。応答が取れなければ`null`（呼び出し側は元の本文のまま続ける） */
export async function generateManualStepNormalization(
  token: string,
  params: { title: string; body: string; findings: string[] },
): Promise<string | null> {
  try {
    const { response, json } = await callClaudeMessages<MessageResponse>({
      feature: "manual_step_normalize",
      token,
      timeoutMs: MANUAL_STEP_NORMALIZE_TIMEOUT_MS,
      body: {
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: buildManualStepNormalizePrompt(params) }],
      },
    });
    if (!response.ok) return null;
    const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
    return text ? text : null;
  } catch (error) {
    console.error("[manual-step-normalize] 整形の生成に失敗しました:", error);
    return null;
  }
}
