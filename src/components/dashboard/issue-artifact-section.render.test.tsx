// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactPreviewProvider } from "@/components/dashboard/artifact-preview";
import { IssueArtifactSection } from "@/components/dashboard/issue-artifact-section";
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

function renderSection(artifacts: SessionArtifactView[]) {
  return render(
    <ArtifactPreviewProvider artifacts={artifacts}>
      <IssueArtifactSection artifacts={artifacts} onReload={() => {}} idPrefix="pc" />
    </ArtifactPreviewProvider>,
  );
}

describe("IssueArtifactSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("1件も無ければ何も出さない（大半のIssueはアーティファクトを作らない）", () => {
    const { container } = renderSection([]);
    expect(container.textContent).toBe("");
  });

  it("畳んだ状態でも件数と先頭の見出しが見える", () => {
    renderSection([artifact(), artifact({ id: "art_2", title: "2つ目" })]);
    expect(screen.getByText("2")).not.toBeNull();
    expect(screen.getByText("見た目案")).not.toBeNull();
  });

  it("開くとカードが並び、押すとアプリ内プレビューのiframeが出る", () => {
    renderSection([artifact()]);
    fireEvent.click(screen.getByRole("button", { name: /アーティファクト/ }));
    fireEvent.click(screen.getByRole("button", { name: "見た目案 をアプリ内で開く" }));

    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("/api/issues/artifacts/art_1");
    // **`allow-same-origin`を付けない**——付けるとアーティファクトのJSからissue-deckの
    // Cookie・localStorageが読める
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("claude.aiで開く導線も残す（アプリ内の表示が崩れたときの逃げ道）", () => {
    renderSection([artifact()]);
    fireEvent.click(screen.getByRole("button", { name: /アーティファクト/ }));

    const link = screen.getByRole("link", { name: "見た目案 をclaude.aiで開く" });
    expect(link.getAttribute("href")).toBe(
      "https://claude.ai/code/artifact/f4de9149-e883-4d06-af33-5da3a592aa59",
    );
  });

  it("URLを覚えていないものにはclaude.aiのリンクを出さない", () => {
    renderSection([artifact({ claudeUrl: null, claudeArtifactId: null })]);
    fireEvent.click(screen.getByRole("button", { name: /アーティファクト/ }));
    expect(screen.queryByRole("link", { name: /claude.aiで開く/ })).toBeNull();
  });
});
