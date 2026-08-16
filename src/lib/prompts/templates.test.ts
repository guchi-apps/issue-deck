import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildImplementationPrompt } from "@/lib/prompts/build-implementation-prompt";
import { GENERIC_IMPLEMENTATION_AGENT_TEMPLATE } from "@/lib/prompts/templates.generated";

/**
 * 生成物（`templates.generated.ts`）がMarkdownの正とずれていないことを検証する。
 *
 * **本番では生成スクリプトが走らない**（デプロイの成果物に`scripts/prompts/`が入っていない）ため、
 * 生成物をコミットして運ぶ形にしている。ここが唯一の歯止めなので、Markdownを編集したら
 * `node scripts/generate-prompt-templates.mjs`を実行し直す必要がある。
 */
describe("プロンプトテンプレートの生成物", () => {
  it("scripts/prompts/generic-implementation-agent.md と一致する", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/prompts/generic-implementation-agent.md"),
      "utf8",
    );
    expect(GENERIC_IMPLEMENTATION_AGENT_TEMPLATE).toBe(source);
  });
});

const BASE = {
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 1263,
  title: "「このPC」を撤去する",
  body: "本文です。",
  labels: [{ name: "51.improvement" }],
  comments: [],
};

describe("buildImplementationPrompt", () => {
  it("置換されないプレースホルダを残さない", () => {
    const prompt = buildImplementationPrompt(BASE);
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("Issueの本文・タイトル・番号・リポジトリを埋める", () => {
    const prompt = buildImplementationPrompt(BASE);
    expect(prompt).toContain("本文です。");
    expect(prompt).toContain("「このPC」を撤去する");
    expect(prompt).toContain("#1263");
    expect(prompt).toContain("guchi-apps/issue-deck");
  });

  it("起動しないと決まらない値は指示ではなく用意する旨に差し替える", () => {
    const prompt = buildImplementationPrompt(BASE);
    expect(prompt).toContain("（貼り付け先のセッションで用意してください）");
  });

  it("何が済んでいて何が済んでいないかを冒頭で断る", () => {
    const prompt = buildImplementationPrompt(BASE);
    expect(prompt).toContain("この文面はissue-deckの画面からコピーされたものです。");
    expect(prompt).toContain("worktreeの作成");
  });

  it("本文が空なら「(本文なし)」にする", () => {
    expect(buildImplementationPrompt({ ...BASE, body: "   " })).toContain("(本文なし)");
    expect(buildImplementationPrompt({ ...BASE, body: null })).toContain("(本文なし)");
  });

  it("コメントをランチャーと同じ書式で並べる", () => {
    const prompt = buildImplementationPrompt({
      ...BASE,
      comments: [
        { author: { login: "m-guchi" }, createdAtLabel: "2026-08-14", body: "1件目" },
        { author: { login: "claude" }, createdAtLabel: "2026-08-15", body: "2件目" },
      ],
    });
    expect(prompt).toContain("- m-guchi (2026-08-14):\n1件目");
    expect(prompt).toContain("- claude (2026-08-15):\n2件目");
  });

  it("コメントが無ければ「(コメントなし)」にする", () => {
    expect(buildImplementationPrompt(BASE)).toContain("(コメントなし)");
  });

  it("23.preview-requiredが付いていれば承認ゲートの手順を出す", () => {
    const prompt = buildImplementationPrompt({
      ...BASE,
      labels: [{ name: "23.preview-required" }],
    });
    expect(prompt).toContain("PRを作成する**前**に次の手順");
    expect(prompt).toContain("明示的な承認を得る");
  });

  it("24.screenshot-requiredが無ければ撮影不要と明記する", () => {
    expect(buildImplementationPrompt(BASE)).toContain("スクリーンショットの自動取得は不要です");
  });

  it("24.screenshot-requiredが付いていれば撮影と承認を求める", () => {
    const prompt = buildImplementationPrompt({
      ...BASE,
      labels: [{ name: "24.screenshot-required" }],
    });
    expect(prompt).toContain("スクリーンショットを取得し、ユーザーの承認を得てから");
  });

  // #1540: 実装が済んでから見せると、見た目がNGだったときに実装がやり直しになる
  it("25.artifact-requiredが無ければアーティファクトは不要と明記する", () => {
    expect(buildImplementationPrompt(BASE)).toContain("アーティファクトの作成は不要です");
  });

  it("25.artifact-requiredが付いていれば実装着手前の公開と承認を求める", () => {
    const prompt = buildImplementationPrompt({
      ...BASE,
      labels: [{ name: "25.artifact-required" }],
    });
    expect(prompt).toContain("**コードを書き始める前に**");
    expect(prompt).toContain("見た目の承認を得てから実装に入ってください");
    // PR作成前ではないことと、Plan modeとの前後関係を落とさない
    expect(prompt).toContain("**Plan modeに入る前に公開**");
    expect(prompt).toContain("実装後にPR本文へURLを貼る必要はありません");
  });

  // #1632: 見た目の合意はPCだけでは足りず、スマホ幅の崩れは実装後に発覚すると作り直しになる
  it("ラベルの有無によらずPC・スマホ(iPhone 15)の2画面を求める", () => {
    for (const labels of [[], [{ name: "25.artifact-required" }]]) {
      const prompt = buildImplementationPrompt({ ...BASE, labels });
      expect(prompt).toContain("iPhone 15 = 幅393px × 高さ852px");
      expect(prompt).toContain("2画面");
    }
  });

  it("ラベルを並べる（無ければ「(なし)」）", () => {
    expect(buildImplementationPrompt({ ...BASE, labels: [] })).toContain("(なし)");
    expect(
      buildImplementationPrompt({
        ...BASE,
        labels: [{ name: "51.improvement" }, { name: "11.local" }],
      }),
    ).toContain("11.local, 51.improvement");
  });
});

// #1741: 共有知識リポジトリ（guchi-apps/docs）を実装対象にする回では、既定の文面
// （「共有知識は読み取り専用」）が指示として自己矛盾する
describe("全アプリ共通の共有知識（#1741）", () => {
  it("通常のリポジトリでは共有知識を読み取り専用として案内する", () => {
    const prompt = buildImplementationPrompt(BASE);
    expect(prompt).toContain("`~/apps/_docs/agent-rules/implementation.md`");
    expect(prompt).toContain("**読み取り専用**として扱い");
    expect(prompt).not.toContain("このリポジトリ自身が全アプリ共通の共有知識リポジトリです");
  });

  it("共有知識リポジトリ自身が対象なら、読み取り専用の案内を出さない", () => {
    const prompt = buildImplementationPrompt({ ...BASE, repositoryFullName: "guchi-apps/docs" });
    expect(prompt).toContain("**このリポジトリ自身が全アプリ共通の共有知識リポジトリです**");
    expect(prompt).not.toContain("**読み取り専用**として扱い");
    // 本体チェックアウトを触らせない禁止事項は、対象がこのリポジトリ自身でも残す
    expect(prompt).toContain("本体チェックアウト");
  });
});

describe("並行状況と親子Issue（#1267）", () => {
  it("親子を渡さなければ「取得していません」と出す（無いのか取っていないのかを区別する）", () => {
    expect(buildImplementationPrompt(BASE)).toContain("（この経路では取得していません）");
  });

  it("親子が空配列なら「ありません」と出す", () => {
    expect(buildImplementationPrompt({ ...BASE, relations: [] })).toContain(
      "(親子関係のあるIssueはありません)",
    );
  });

  it("親と子を並べる", () => {
    const prompt = buildImplementationPrompt({
      ...BASE,
      relations: [
        { number: 1261, title: "親のタイトル", state: "open", relation: "parent" },
        { number: 1268, title: "子のタイトル", state: "closed", relation: "sub" },
      ],
    });
    expect(prompt).toContain("- 親: #1261 親のタイトル（open）");
    expect(prompt).toContain("- 子: #1268 子のタイトル（closed）");
  });

  // ブラウザからはgitもghも叩けない。黙って空にすると「並行しているものは無い」と読まれる
  it("並行状況は取得できない旨と、自分で確認するコマンドを出す", () => {
    const prompt = buildImplementationPrompt(BASE);
    expect(prompt).toContain("並行状況は取得できていません");
    expect(prompt).toContain("gh pr list --repo guchi-apps/issue-deck");
  });

  it("画像はWebFetchで読むよう促す", () => {
    expect(buildImplementationPrompt(BASE)).toContain("`WebFetch`でそのURLを読んでください");
  });
});
