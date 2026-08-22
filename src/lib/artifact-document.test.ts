import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CONTENT_SECURITY_POLICY,
  ARTIFACT_IFRAME_SANDBOX,
  buildArtifactDocument,
  parseArtifactUrlId,
} from "@/lib/artifact-document";

const ID = "f4de9149-e883-4d06-af33-5da3a592aa59";

describe("parseArtifactUrlId", () => {
  it("`/code/artifact/<id>`からIDを取り出す", () => {
    expect(parseArtifactUrlId(`https://claude.ai/code/artifact/${ID}`)).toBe(ID);
  });

  it("公開ページ（`/public/artifacts/<id>`）も同じ扱い", () => {
    expect(parseArtifactUrlId(`https://claude.ai/public/artifacts/${ID}`)).toBe(ID);
  });

  it("クエリ・フラグメントが付いていても取り出せる", () => {
    expect(parseArtifactUrlId(`https://claude.ai/code/artifact/${ID}?v=2#top`)).toBe(ID);
  });

  it("claude.ai以外・別のパス・IDの形が違うものは受け取らない", () => {
    expect(parseArtifactUrlId(`https://example.com/code/artifact/${ID}`)).toBeNull();
    expect(parseArtifactUrlId(`https://claude.ai/code/session/${ID}`)).toBeNull();
    expect(parseArtifactUrlId("https://claude.ai/code/artifact/not-a-uuid")).toBeNull();
    expect(parseArtifactUrlId(null)).toBeNull();
  });

  it("httpは受け取らない（URLはそのまま画面のリンクになる）", () => {
    expect(parseArtifactUrlId(`http://claude.ai/code/artifact/${ID}`)).toBeNull();
  });
});

describe("buildArtifactDocument", () => {
  it("断片を`<!doctype html>`から始まる1枚の文書へ包む", () => {
    const html = buildArtifactDocument({ html: "<main>本文</main>", title: "見た目案" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>見た目案</title>");
    expect(html).toContain("<main>本文</main>");
  });

  it("タイトルはエスケープする（`<title>`を閉じさせない）", () => {
    const html = buildArtifactDocument({ html: "<p>x</p>", title: '</title><script>alert(1)</script>' });
    expect(html).not.toContain("</title><script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
  });

  it("`data-theme`は立てない（アーティファクト側の配色分岐を壊さない）", () => {
    const html = buildArtifactDocument({ html: "<p>x</p>", title: "t" });
    expect(html).not.toContain("data-theme");
    expect(html).toContain('content="light dark"');
  });

  it("すでに完全な文書ならそのまま返す（二重に包まない）", () => {
    const source = "<!DOCTYPE html>\n<html><body>done</body></html>";
    expect(buildArtifactDocument({ html: source, title: "t" })).toBe(source);
  });
});

describe("配信の隔離", () => {
  it("iframeのsandboxに`allow-same-origin`を含めない", () => {
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(ARTIFACT_IFRAME_SANDBOX).toContain("allow-scripts");
  });

  it("CSPでもsandboxし、外部への通信を塞ぐ", () => {
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("sandbox allow-scripts");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
  });
});
