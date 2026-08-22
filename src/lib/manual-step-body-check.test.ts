import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkManualStepBody } from "@/lib/manual-step-body-check";

/**
 * 雛形（`docs/multi-agent/manual-step-body-template.md`）のコードブロックの中身を取り出す。
 *
 * **雛形そのものが検査を通ることを、この仕組みの最低条件にする。** 雛形を直したのに検査が
 * 追いついていない（またはその逆）と、起票する側は雛形どおりに書いたのに毎回指摘される。
 */
function templateBody(): string {
  const source = readFileSync(
    join(process.cwd(), "docs/multi-agent/manual-step-body-template.md"),
    "utf8",
  );
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("````markdown"));
  const end = lines.findIndex((line, index) => index > start && line === "````");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).join("\n");
}

const rules = (body: string, repositoryFullName?: string) =>
  checkManualStepBody(body, { repositoryFullName }).map((finding) => finding.rule);

describe("checkManualStepBody", () => {
  it("雛形そのものは指摘なしで通る", () => {
    expect(checkManualStepBody(templateBody())).toEqual([]);
  });

  it("本文が空なら1件だけ返す", () => {
    for (const body of [null, undefined, "", "   \n  "]) {
      expect(rules(body as string)).toEqual(["empty-body"]);
    }
  });

  it("見出しの補足（`## やること（サブPC）`）や表記揺れは通す", () => {
    const body = templateBody()
      .replace("## やること", "## やること（サブPC）")
      .replace("## 完了の確認方法", "## 確認方法");
    expect(rules(body)).toEqual([]);
  });
});

describe("見出し", () => {
  it("足りない見出しを挙げる", () => {
    const body = templateBody().replace("## なぜエージェントが実施しないか", "## 補足");
    const findings = checkManualStepBody(body);
    expect(findings.map((finding) => finding.rule)).toContain("missing-heading");
    expect(findings[0].message).toContain("なぜエージェントが実施しないか");
  });

  it("順が入れ替わっていれば指摘する（節そのものは読めるのでwarning）", () => {
    const body = templateBody();
    const [before, after] = [body.indexOf("## 前提条件"), body.indexOf("## やること")];
    const swapped =
      body.slice(0, before) + body.slice(after) + "\n" + body.slice(before, after);
    const findings = checkManualStepBody(swapped);
    const order = findings.find((finding) => finding.rule === "heading-order");
    expect(order?.severity).toBe("warning");
  });
});

describe("前提条件", () => {
  it("デバイスの行が無ければerrorで指摘する", () => {
    const body = templateBody().replace(
      /- 実行するデバイス: .*\n/,
      "",
    );
    const finding = checkManualStepBody(body).find(
      (entry) => entry.rule === "missing-prerequisite",
    );
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("実行するデバイス");
  });

  it("その他の前提が無いだけならwarningに留める", () => {
    const body = templateBody().replace(/- その他の前提: .*\n/, "");
    const finding = checkManualStepBody(body).find(
      (entry) => entry.rule === "missing-prerequisite",
    );
    expect(finding?.severity).toBe("warning");
  });

  // guchi-apps/asset-manager#210 が80字で折り返しており、`その他の前提`の値が途中で切れていた
  it("項目が次の行へ折り返していれば指摘する", () => {
    const body = templateBody().replace(
      "- その他の前提: （必要な権限・トークン、起動しておくサービスなど。無ければ「なし」）",
      "- その他の前提: 1Passwordの `apps` vault の `AssetManager` 項目を編集できること、\n  `gh` が認証済みであること",
    );
    expect(rules(body)).toContain("wrapped-prerequisite");
  });

  it("ラベルが太字でも項目として読む（画面のパーサーと同じ）", () => {
    const body = templateBody().replace("- 実行するデバイス:", "- **実行するデバイス**:");
    expect(rules(body)).toEqual([]);
  });
});

describe("実行するデバイス", () => {
  // guchi-apps/car-care#99 の「ブラウザ（Zaim 開発者ページ・1Password）と、サブPCの端末」
  it("端末が2つ以上書かれていれば指摘する", () => {
    const body = templateBody().replace(
      /- 実行するデバイス: .*/,
      "- 実行するデバイス: ブラウザ（Zaim 開発者ページ・1Password）と、サブPCの端末",
    );
    const finding = checkManualStepBody(body).find(
      (entry) => entry.rule === "multiple-devices",
    );
    expect(finding?.message).toContain("サブPC");
    expect(finding?.message).toContain("ブラウザ");
  });

  it("1つだけなら指摘しない（括弧書きの補足は端末名として数えない）", () => {
    const body = templateBody().replace(
      /- 実行するデバイス: .*/,
      "- 実行するデバイス: サブPC（メインPCからなら `ssh subpc`）",
    );
    expect(rules(body)).toEqual([]);
  });
});

describe("やること", () => {
  it("1つの手順にコードブロックが2つあればerrorで指摘する", () => {
    const body = templateBody().replace(
      "- [ ] （2手順目）",
      ["- [ ] （2手順目）", "", "  ```bash", "  echo one", "  ```", "", "  ```bash", "  echo two", "  ```"].join("\n"),
    );
    const finding = checkManualStepBody(body).find(
      (entry) => entry.rule === "multiple-blocks-in-step",
    );
    expect(finding?.severity).toBe("error");
  });

  it("チェックリストが無いままコードブロックが2つ以上あれば指摘する", () => {
    const body = templateBody().replace(
      /## やること\n[\s\S]*?\n## 完了の確認方法/,
      ["## やること", "", "```bash", "echo one", "```", "", "```bash", "echo two", "```", "", "## 完了の確認方法"].join("\n"),
    );
    expect(rules(body)).toContain("todo-not-checklist");
  });

  it("チェックリストが無くてもコードブロックが1つなら指摘しない", () => {
    const body = templateBody().replace(
      /## やること\n[\s\S]*?\n## 完了の確認方法/,
      ["## やること", "", "```bash", "echo one", "```", "", "## 完了の確認方法"].join("\n"),
    );
    expect(rules(body)).toEqual([]);
  });
});

describe("関連の参照", () => {
  // guchi-apps/aide#103・car-care#99 が対応PRをURLで書いており、参照抽出から落ちていた
  it("URLで書かれていればerrorで指摘し、同じリポジトリなら#番号を提案する", () => {
    const body = templateBody().replace(
      "- 対応PR: #<番号>",
      "- 対応PR: https://github.com/guchi-apps/aide/pull/102",
    );
    const finding = checkManualStepBody(body, {
      repositoryFullName: "guchi-apps/aide",
    }).find((entry) => entry.rule === "reference-not-hash-form");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("#102");
    expect(finding?.message).not.toContain("guchi-apps/aide#102");
  });

  it("別リポジトリならowner/repo#番号を提案する", () => {
    const body = templateBody().replace(
      "- 対応PR: #<番号>",
      "- 対応PR: https://github.com/guchi-apps/aide/pull/102",
    );
    const finding = checkManualStepBody(body, {
      repositoryFullName: "guchi-apps/issue-deck",
    }).find((entry) => entry.rule === "reference-not-hash-form");
    expect(finding?.message).toContain("guchi-apps/aide#102");
  });

  it("同じ行に#番号があればURLが併記されていても指摘しない", () => {
    const body = templateBody().replace(
      "- 対応PR: #<番号>",
      "- 対応PR: #102 https://github.com/guchi-apps/aide/pull/102",
    );
    expect(rules(body)).toEqual([]);
  });
});
