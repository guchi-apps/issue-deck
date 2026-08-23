// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactPreviewProvider } from "@/components/dashboard/artifact-preview";
import { IssueArtifactPanel } from "@/components/dashboard/issue-artifact-panel";
import type { SessionArtifactView } from "@/lib/dispatch/session-artifact";

function artifact(overrides: Partial<SessionArtifactView> = {}): SessionArtifactView {
  return {
    id: "art_1",
    title: "見た目案",
    description: null,
    favicon: "🖼️",
    claudeUrl: "https://claude.ai/code/artifact/f4de9149-e883-4d06-af33-5da3a592aa59",
    claudeArtifactId: "f4de9149-e883-4d06-af33-5da3a592aa59",
    hostName: "subpc",
    byteSize: 1234,
    publishedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(artifacts: SessionArtifactView[]) {
  return render(
    <ArtifactPreviewProvider artifacts={artifacts}>
      <IssueArtifactPanel artifacts={artifacts} onReload={() => {}} />
    </ArtifactPreviewProvider>,
  );
}

/** プレビュー（重ね表示）のiframe。サムネイルと違い`title`が「〜のサムネイル」ではない */
function previewFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(
    'iframe:not([title$="のサムネイル"])',
  );
}

describe("IssueArtifactPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("1件も無ければ何も出さない（大半のIssueはアーティファクトを作らない）", () => {
    const { container } = renderPanel([]);
    expect(container.textContent).toBe("");
  });

  it("畳まずに件数と各件の見出しを出す（#2190。開く操作を挟まずに見えている）", () => {
    renderPanel([artifact(), artifact({ id: "art_2", title: "2つ目" })]);
    expect(screen.getByText("2")).not.toBeNull();
    expect(screen.getByText(/見た目案/)).not.toBeNull();
    expect(screen.getByText(/2つ目/)).not.toBeNull();
  });

  it("サムネイルは保存済みHTMLのiframeで、`allow-same-origin`を付けない", () => {
    renderPanel([artifact()]);

    const thumbnail = document.querySelector<HTMLIFrameElement>('iframe[title$="のサムネイル"]');
    expect(thumbnail?.getAttribute("src")).toBe("/api/issues/artifacts/art_1");
    expect(thumbnail?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(thumbnail?.getAttribute("loading")).toBe("lazy");
  });

  it("「開く」でアプリ内プレビューのiframeが出る", () => {
    renderPanel([artifact()]);
    fireEvent.click(screen.getByRole("button", { name: "開く" }));

    const frame = previewFrame();
    expect(frame?.getAttribute("src")).toBe("/api/issues/artifacts/art_1");
    // **`allow-same-origin`を付けない**——付けるとアーティファクトのJSからissue-deckの
    // Cookie・localStorageが読める
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("カード全面を押しても開ける（従来の操作を残す）", () => {
    renderPanel([artifact()]);
    fireEvent.click(screen.getByRole("button", { name: "見た目案 をアプリ内で開く" }));
    expect(previewFrame()?.getAttribute("src")).toBe("/api/issues/artifacts/art_1");
  });

  it("claude.aiで開く導線も残す（アプリ内の表示が崩れたときの逃げ道）", () => {
    renderPanel([artifact()]);

    const link = screen.getByRole("link", { name: "見た目案 をclaude.aiで開く" });
    expect(link.getAttribute("href")).toBe(
      "https://claude.ai/code/artifact/f4de9149-e883-4d06-af33-5da3a592aa59",
    );
  });

  it("URLを覚えていないものにはclaude.aiのリンクを出さない", () => {
    renderPanel([artifact({ claudeUrl: null, claudeArtifactId: null })]);
    expect(screen.queryByRole("link", { name: /claude.aiで開く/ })).toBeNull();
  });

  it("古いものはサムネイルを作らない（Issueを開いた時点で全件を取りに行かない）", () => {
    renderPanel(
      Array.from({ length: 8 }, (_, index) =>
        artifact({ id: `art_${index}`, title: `見た目案${index}` }),
      ),
    );
    expect(document.querySelectorAll('iframe[title$="のサムネイル"]').length).toBe(6);
  });
});
