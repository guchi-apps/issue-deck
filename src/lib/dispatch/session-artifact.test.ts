import { describe, expect, it } from "vitest";

import {
  parseSessionArtifactDescription,
  parseSessionArtifactFavicon,
  parseSessionArtifactHtml,
  parseSessionArtifactSourcePath,
  parseSessionArtifactTitle,
  resolveSessionArtifactTitle,
  SESSION_ARTIFACT_HTML_LIMIT,
} from "@/lib/dispatch/session-artifact";

describe("parseSessionArtifactHtml", () => {
  it("中身のあるHTMLをそのまま通す（前後の空白も落とさない）", () => {
    expect(parseSessionArtifactHtml("\n<main>x</main>\n")).toBe("\n<main>x</main>\n");
  });

  it("空・空白だけ・文字列以外は受け取らない", () => {
    expect(parseSessionArtifactHtml("")).toBeNull();
    expect(parseSessionArtifactHtml("   \n ")).toBeNull();
    expect(parseSessionArtifactHtml(undefined)).toBeNull();
  });

  it("上限を超えるものは受け取らない", () => {
    expect(parseSessionArtifactHtml("a".repeat(SESSION_ARTIFACT_HTML_LIMIT + 1))).toBeNull();
  });

  it("上限はバイト数で見る（マルチバイトでも溢れさせない）", () => {
    const justOver = "あ".repeat(Math.ceil(SESSION_ARTIFACT_HTML_LIMIT / 3) + 1);
    expect(justOver.length).toBeLessThan(SESSION_ARTIFACT_HTML_LIMIT);
    expect(parseSessionArtifactHtml(justOver)).toBeNull();
  });
});

describe("parseSessionArtifactSourcePath", () => {
  it("空だけを弾く", () => {
    expect(parseSessionArtifactSourcePath("/tmp/x/plan.html")).toBe("/tmp/x/plan.html");
    expect(parseSessionArtifactSourcePath("  ")).toBeNull();
    expect(parseSessionArtifactSourcePath(42)).toBeNull();
  });
});

describe("短い文字列の受け取り", () => {
  it("見出しは空白を畳んで通す", () => {
    expect(parseSessionArtifactTitle("  見た目案\n  PC・スマホ ")).toBe("見た目案 PC・スマホ");
    expect(parseSessionArtifactTitle("")).toBeNull();
  });

  it("長すぎる見出しは切って通す（受け取り自体は拒否しない）", () => {
    const title = parseSessionArtifactTitle("あ".repeat(300));
    expect(title).toHaveLength(200);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("説明も同じ扱い", () => {
    expect(parseSessionArtifactDescription(" 一覧の見た目 ")).toBe("一覧の見た目");
    expect(parseSessionArtifactDescription(null)).toBeNull();
  });

  it("faviconは長さだけで切る（絵文字かどうかは見ない）", () => {
    expect(parseSessionArtifactFavicon("📊")).toBe("📊");
    expect(parseSessionArtifactFavicon("これは絵文字ではない長い文字列")).toBeNull();
    expect(parseSessionArtifactFavicon(" ")).toBeNull();
  });
});

describe("resolveSessionArtifactTitle", () => {
  const sourcePath = "/home/guchi/scratch/design-draft.html";

  it("HTMLの`<title>`を最優先する（claude.aiと同じ並び）", () => {
    expect(
      resolveSessionArtifactTitle({
        title: "引数のタイトル",
        html: "<title>本文のタイトル</title><main>x</main>",
        sourcePath,
      }),
    ).toBe("本文のタイトル");
  });

  it("`<title>`が無ければ渡された見出しを使う", () => {
    expect(
      resolveSessionArtifactTitle({ title: "引数のタイトル", html: "<main>x</main>", sourcePath }),
    ).toBe("引数のタイトル");
  });

  it("どちらも無ければファイル名（拡張子なし）へ落とす", () => {
    expect(resolveSessionArtifactTitle({ title: null, html: "<main>x</main>", sourcePath })).toBe(
      "design-draft",
    );
  });

  it("`<title>`の実体参照は戻す", () => {
    expect(
      resolveSessionArtifactTitle({
        title: null,
        html: "<title>A &amp; B</title>",
        sourcePath,
      }),
    ).toBe("A & B");
  });

  it("空の`<title>`は無いものとして扱う", () => {
    expect(
      resolveSessionArtifactTitle({ title: "引数のタイトル", html: "<title>  </title>", sourcePath }),
    ).toBe("引数のタイトル");
  });
});
