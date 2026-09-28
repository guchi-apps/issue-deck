// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WebviewIosInstructions } from "@/components/dashboard/webview-ios-instructions";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

describe("WebviewIosInstructions", () => {
  afterEach(() => {
    cleanup();
  });

  const repo = getWebviewIosRepository("guchi-apps/myroom")!;

  it("Web側だけの変更と、iOS本体の入れ直しを分けて表示する", () => {
    render(<WebviewIosInstructions repo={repo} />);
    expect(screen.getByText("Webだけ更新（frontend・backendの変更）")).not.toBeNull();
    expect(
      screen.getByText("アプリ本体の入れ直し（ios/・アプリアイコンの変更）"),
    ).not.toBeNull();
    expect(screen.getByText((_, element) => element?.textContent === repo.command)).not.toBeNull();
  });

  it("初回セットアップの参照リンクを表示する", () => {
    render(<WebviewIosInstructions repo={repo} />);
    for (const ref of repo.setupReferences) {
      expect(screen.getByText(ref.label)).not.toBeNull();
    }
  });
});
