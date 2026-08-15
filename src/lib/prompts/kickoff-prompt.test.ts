import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { START_IMPLEMENTATION_OPTIONS } from "@/lib/github/start-implementation";

/**
 * セッションのキックオフ文面を組み立てるシェル関数（`scripts/lib/kickoff-prompt.sh`・#1559）の
 * テスト。**シェルをそのまま起こして叩く**（`src/lib/workflows/prompt-placeholders.test.ts` が
 * `envsubst` を起こしているのと同じ形）。
 *
 * ここで一番効くのは「オプション名のドリフト検知」。オプションの日本語名は画面
 * （`START_IMPLEMENTATION_OPTIONS`）とシェルの2か所にあり、ずれると**画面で選んだ名前と
 * 起動したセッションに出る名前が食い違う**。片方だけ直したらこのテストが落ちる。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../../scripts/lib/kickoff-prompt.sh");

function callShell(fn: string, ...args: string[]): string {
  return execFileSync("bash", ["-c", `source "$0"; ${fn} "$@"`, SCRIPT_PATH, ...args], {
    encoding: "utf-8",
  }).replace(/\n$/, "");
}

let workDir: string;

function writePrompt(name: string, content: string): string {
  const filePath = path.join(workDir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "kickoff-prompt-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("kickoff_prompt_field", () => {
  it("`- キー: 値`の行を読む", () => {
    const file = writePrompt(
      "field.md",
      ["## 対応Issue", "", "- 番号: #1559", "- タイトル: 画面に概要を出す", "- ラベル: 11.local, 50.feature", ""].join(
        "\n",
      ),
    );
    expect(callShell("kickoff_prompt_field", file, "タイトル")).toBe("画面に概要を出す");
    expect(callShell("kickoff_prompt_field", file, "ラベル")).toBe("11.local, 50.feature");
  });

  it("行が無ければ空を返す（横断質問セッションのテンプレートにはラベルが無い）", () => {
    const file = writePrompt("no-label.md", "- タイトル: 質問\n");
    expect(callShell("kickoff_prompt_field", file, "ラベル")).toBe("");
  });

  it("ファイルが無くても失敗しない", () => {
    expect(callShell("kickoff_prompt_field", path.join(workDir, "missing.md"), "タイトル")).toBe("");
  });
});

describe("kickoff_prompt_summary", () => {
  it("画像・見出し・コードブロック・箇条書きの記号を落として1行に畳む", () => {
    const file = writePrompt(
      "summary.md",
      [
        "## 対応Issue",
        "",
        "- タイトル: 画面に概要を出す",
        "",
        "### 本文",
        "",
        "![image.png](https://example.com/api/issues/images/abc.png)",
        "",
        "現在は**タイトル**のみが出ています。次も出してください。",
        "",
        "- 概要",
        "- オプション",
        "",
        "```bash",
        "pnpm dev",
        "```",
        "",
        "### 関連するIssue",
        "",
        "- 親: #1000 別のIssue",
        "",
      ].join("\n"),
    );
    expect(callShell("kickoff_prompt_summary", file)).toBe(
      "現在はタイトルのみが出ています。次も出してください。 概要 オプション",
    );
  });

  it("本文が見出しで始まっていても中身を拾う", () => {
    const file = writePrompt(
      "heading-first.md",
      ["### 本文", "", "## 背景", "", "説明の本文です。", "", "### 既存コメント", "", "(コメントなし)", ""].join("\n"),
    );
    expect(callShell("kickoff_prompt_summary", file)).toBe("背景 説明の本文です。");
  });

  it("上限を超えたぶんは切り捨てて「…」を付ける（psに本文を丸ごと出さないため・#1405）", () => {
    const body = "あ".repeat(200);
    const file = writePrompt("long.md", ["### 本文", "", body, "", "### 既存コメント", ""].join("\n"));
    // 第2引数で上限を渡せる（既定は150文字）
    expect(callShell("kickoff_prompt_summary", file, "10")).toBe(`${"あ".repeat(10)}…`);
    expect(callShell("kickoff_prompt_summary", file)).toBe(`${"あ".repeat(150)}…`);
  });

  it("本文が無い・本文セクションが無ければ空を返す", () => {
    const noBody = writePrompt("no-body.md", ["### 本文", "", "(本文なし)", "", "### 既存コメント", ""].join("\n"));
    expect(callShell("kickoff_prompt_summary", noBody)).toBe("");

    const noSection = writePrompt("no-section.md", "- タイトル: 質問\n");
    expect(callShell("kickoff_prompt_summary", noSection)).toBe("");
  });
});

describe("kickoff_prompt_options", () => {
  it("オプションのラベルだけを日本語名にして並べる", () => {
    expect(callShell("kickoff_prompt_options", "11.local, 21.plan-required, 50.feature")).toBe("計画が必要");
    expect(callShell("kickoff_prompt_options", "23.preview-required, 21.plan-required")).toBe(
      "計画が必要 / 開発環境を起動する",
    );
  });

  it("オプションのラベルが無ければ空を返す", () => {
    expect(callShell("kickoff_prompt_options", "11.local, 50.feature")).toBe("");
    expect(callShell("kickoff_prompt_options", "")).toBe("");
  });

  it("部分一致では拾わない", () => {
    expect(callShell("kickoff_prompt_options", "121.plan-required, 21.plan-required-old")).toBe("");
  });

  it("画面（START_IMPLEMENTATION_OPTIONS）と名前・並び順が一致している", () => {
    for (const option of START_IMPLEMENTATION_OPTIONS) {
      expect(callShell("kickoff_prompt_options", option.githubLabel)).toBe(option.label);
    }
    const allLabels = START_IMPLEMENTATION_OPTIONS.map((option) => option.githubLabel).join(", ");
    expect(callShell("kickoff_prompt_options", allLabels)).toBe(
      START_IMPLEMENTATION_OPTIONS.map((option) => option.label).join(" / "),
    );
  });
});

describe("kickoff_prompt_dev_environment", () => {
  it("起動済みかどうかとtailnetのURLで書き分ける", () => {
    expect(callShell("kickoff_prompt_dev_environment", "5559", "", "1")).toBe("http://localhost:5559（起動済み）");
    expect(callShell("kickoff_prompt_dev_environment", "5559", "https://subpc.example.ts.net/", "1")).toBe(
      "http://localhost:5559（起動済み / tailnet: https://subpc.example.ts.net/）",
    );
    expect(callShell("kickoff_prompt_dev_environment", "5559", "", "0")).toContain("未起動");
  });

  it("ポートが無い経路（横断質問セッション）では空を返す", () => {
    expect(callShell("kickoff_prompt_dev_environment", "0", "", "0")).toBe("");
    expect(callShell("kickoff_prompt_dev_environment", "", "", "0")).toBe("");
  });
});

describe("kickoff_prompt_context_block", () => {
  it("取れた項目だけを並べる", () => {
    const file = writePrompt(
      "block.md",
      [
        "- タイトル: 画面に概要を出す",
        "- ラベル: 11.local, 21.plan-required",
        "",
        "### 本文",
        "",
        "説明の本文です。",
        "",
        "### 既存コメント",
        "",
      ].join("\n"),
    );
    expect(callShell("kickoff_prompt_context_block", file, "5559", "", "1")).toBe(
      ["- 概要: 説明の本文です。", "- オプション: 計画が必要", "- 開発環境: http://localhost:5559（起動済み）"].join(
        "\n",
      ),
    );
  });

  it("何も取れなければ空を返す（従来どおりの1文だけで起動する）", () => {
    const file = writePrompt("empty.md", "- タイトル: 質問\n");
    expect(callShell("kickoff_prompt_context_block", file, "0", "", "0")).toBe("");
  });
});
