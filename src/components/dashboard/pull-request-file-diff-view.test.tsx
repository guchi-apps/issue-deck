// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PullRequestFileDiffView } from "@/components/dashboard/pull-request-file-diff-view";

afterEach(() => {
  cleanup();
});

describe("PullRequestFileDiffView", () => {
  it("追加・削除・hunk見出し・コンテキスト行をそれぞれ表示する", () => {
    const patch = ["@@ -1,2 +1,2 @@", " unchanged", "-old", "+new"].join("\n");
    render(<PullRequestFileDiffView patch={patch} />);

    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeTruthy();
    expect(screen.getByText("unchanged")).toBeTruthy();
    expect(screen.getByText("-old")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();
  });

  it("改行無し警告（\\ No newline at end of file）も1行として表示する", () => {
    const patch = ["@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file"].join("\n");
    render(<PullRequestFileDiffView patch={patch} />);

    expect(screen.getByText("\\ No newline at end of file")).toBeTruthy();
  });
});
