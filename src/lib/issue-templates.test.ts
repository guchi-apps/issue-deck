import { describe, expect, it } from "vitest";

import {
  findIssueTemplate,
  isUnfilledTemplateBody,
  ISSUE_TEMPLATES,
  resolveTemplateChange,
} from "@/lib/issue-templates";

const FEATURE = ISSUE_TEMPLATES[0];
const IMPROVE = ISSUE_TEMPLATES[1];

describe("ISSUE_TEMPLATES", () => {
  it("3種で、見出しだけを含む（説明文を入れない）", () => {
    expect(ISSUE_TEMPLATES.map((template) => template.id)).toEqual([
      "feature",
      "improve",
      "bug",
    ]);
    for (const template of ISSUE_TEMPLATES) {
      const lines = template.body.split("\n").filter((line) => line.trim());
      expect(lines.every((line) => line.startsWith("## "))).toBe(true);
    }
  });

  it("機能追加には理由を書く見出しがある（代替案を出せるようにするため）", () => {
    expect(FEATURE.body).toContain("## なぜ追加したいか");
  });
});

describe("findIssueTemplate", () => {
  it("未選択（null）ではnullを返す", () => {
    expect(findIssueTemplate(null)).toBeNull();
  });

  it("idで引ける", () => {
    expect(findIssueTemplate("bug")?.label).toBe("不具合");
  });
});

describe("resolveTemplateChange", () => {
  it("本文が空なら、確認せずそのまま入れる", () => {
    expect(resolveTemplateChange({ nextId: "feature", appliedId: null, body: "" })).toEqual({
      kind: "apply",
      templateId: "feature",
      body: FEATURE.body,
    });
  });

  it("入れたままの骨組みなら、確認せず別のテンプレートへ入れ替える", () => {
    expect(
      resolveTemplateChange({ nextId: "improve", appliedId: "feature", body: FEATURE.body }),
    ).toEqual({ kind: "apply", templateId: "improve", body: IMPROVE.body });
  });

  it("自分で書いた内容があるときは、置き換えの確認を求める", () => {
    expect(
      resolveTemplateChange({ nextId: "bug", appliedId: null, body: "件数の表示が合っていない" }),
    ).toEqual({ kind: "confirm" });
  });

  it("骨組みを埋めた後に別のテンプレートを押した場合も確認を求める", () => {
    expect(
      resolveTemplateChange({
        nextId: "bug",
        appliedId: "feature",
        body: `${FEATURE.body}カンバンに件数を出したい`,
      }),
    ).toEqual({ kind: "confirm" });
  });

  it("選択中のチップを押し直すと、骨組みのままなら本文も空へ戻す", () => {
    expect(
      resolveTemplateChange({ nextId: "feature", appliedId: "feature", body: FEATURE.body }),
    ).toEqual({ kind: "apply", templateId: null, body: "" });
  });

  it("選択中のチップを押し直したとき、書いた内容があれば選択だけ外す", () => {
    expect(
      resolveTemplateChange({
        nextId: "feature",
        appliedId: "feature",
        body: `${FEATURE.body}カンバンに件数を出したい`,
      }),
    ).toEqual({ kind: "detach" });
  });

  it("空行の増減では確認を求めない（trimして比べる）", () => {
    expect(
      resolveTemplateChange({
        nextId: "bug",
        appliedId: "feature",
        body: `\n${FEATURE.body}\n\n`,
      }),
    ).toEqual({ kind: "apply", templateId: "bug", body: ISSUE_TEMPLATES[2].body });
  });
});

describe("isUnfilledTemplateBody", () => {
  it("骨組みのままならtrue", () => {
    expect(isUnfilledTemplateBody(FEATURE.body, "feature")).toBe(true);
  });

  it("1つでも埋めていればfalse", () => {
    expect(isUnfilledTemplateBody(`${FEATURE.body}カンバンに件数を出したい`, "feature")).toBe(
      false,
    );
  });

  it("テンプレート未選択ならfalse（空欄の判定は既存のcanProceedFromInputが持つ）", () => {
    expect(isUnfilledTemplateBody("", null)).toBe(false);
  });
});
