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
