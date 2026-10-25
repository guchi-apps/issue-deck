// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  RemoteSessionActiveList,
  selectActiveRemoteSessions,
} from "@/components/dashboard/remote-session-active-list";
import type { RemoteSessionView } from "@/lib/dispatch/remote-session-rules";

afterEach(cleanup);

function session(overrides: Partial<RemoteSessionView>): RemoteSessionView {
  return {
    id: "s1",
    repositoryFullName: "guchi-apps/issue-deck",
    host: "subpc",
    tmuxSessionName: "issue-deck-remote-abcd1234",
    status: "running",
    remoteControlUrl: "https://claude.ai/code/session_x",
    failureMessage: null,
    stopping: false,
    createdAt: "2026-10-24T00:00:00.000Z",
    lastSeenAt: null,
    ...overrides,
  };
}

describe("RemoteSessionActiveList", () => {
  it("終了済み・終了中を除いて新しい順に並べる", () => {
    const rows = selectActiveRemoteSessions([
      session({ id: "old", createdAt: "2026-10-23T00:00:00.000Z" }),
      session({ id: "ended", status: "ended" }),
      session({ id: "stopping", stopping: true }),
      session({ id: "new", status: "starting", createdAt: "2026-10-24T01:00:00.000Z" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("URLがあれば1クリックで開けるリンクを、無ければ準備中を出す", () => {
    render(
      <RemoteSessionActiveList
        sessions={[session({ id: "a" }), session({ id: "b", status: "starting", remoteControlUrl: null })]}
      />,
    );
    expect(screen.getByRole("link", { name: /開く/ }).getAttribute("href")).toBe("https://claude.ai/code/session_x");
    expect(screen.getByText("準備中")).toBeTruthy();
  });

  it("起動中が無ければその旨を出す", () => {
    render(<RemoteSessionActiveList sessions={[]} />);
    expect(screen.getByText("起動中のセッションはありません。")).toBeTruthy();
  });
});
