import { describe, expect, it } from "vitest";

import { parseRemoteControlUrl } from "@/lib/dispatch/session-state";
import {
  REMOTE_SESSION_MAX_PER_HOST,
  REMOTE_SESSION_NAME_PATTERN,
  buildRemoteSessionName,
  isRemoteSessionResumable,
  parseIdleEndedRemoteSessions,
  parseReportedRemoteSessions,
  pickRemoteSessionHost,
  resolveRemoteSessionRejection,
  selectHostRemoteSessions,
  summarizeRemoteSessionNav,
  supportsRemoteSessionResume,
  type RemoteSessionHostInfo,
  type RemoteSessionView,
} from "@/lib/dispatch/remote-session-rules";

const host = (overrides: Partial<RemoteSessionHostInfo> = {}): RemoteSessionHostInfo => ({
  name: "subpc",
  online: true,
  remoteSessionCapable: true,
  repositories: ["guchi-apps/issue-deck"],
  activeCount: 0,
  resumeCapable: true,
  ...overrides,
});

describe("buildRemoteSessionName", () => {
  it("リポジトリ名と8文字の接尾辞で、pollerと同じ形の名前を作る", () => {
    const name = buildRemoteSessionName("guchi-apps/issue-deck", () => 0);
    expect(name).toBe("issue-deck-remote-aaaaaaaa");
    expect(REMOTE_SESSION_NAME_PATTERN.test(name)).toBe(true);
  });

  it("tmuxが受け付けない`.`を置き換え、実装セッションの`-issue-`規約に当たらない", () => {
    const name = buildRemoteSessionName("m-guchi/my.app");
    expect(name.startsWith("my-app-remote-")).toBe(true);
    expect(REMOTE_SESSION_NAME_PATTERN.test(name)).toBe(true);
    expect(/-issue-[1-9][0-9]*$/.test(name)).toBe(false);
  });
});

describe("resolveRemoteSessionRejection", () => {
  it("オフライン・pollerが古い・未登録・上限の順に理由を返す", () => {
    expect(resolveRemoteSessionRejection(null, "guchi-apps/issue-deck")).toBe("no_host");
    expect(resolveRemoteSessionRejection(host({ online: false }), "guchi-apps/issue-deck")).toBe("host_offline");
    expect(resolveRemoteSessionRejection(host({ remoteSessionCapable: false }), "guchi-apps/issue-deck")).toBe("unsupported");
    expect(resolveRemoteSessionRejection(host(), "guchi-apps/other")).toBe("repository_not_runnable");
    expect(
      resolveRemoteSessionRejection(host({ activeCount: REMOTE_SESSION_MAX_PER_HOST }), "guchi-apps/issue-deck"),
    ).toBe("limit_reached");
    expect(resolveRemoteSessionRejection(host(), "guchi-apps/issue-deck")).toBeNull();
  });
});

describe("pickRemoteSessionHost", () => {
  it("起動できるホストを優先する", () => {
    const old = host({ name: "old", remoteSessionCapable: false });
    const ok = host({ name: "ok" });
    expect(pickRemoteSessionHost([old, ok], "guchi-apps/issue-deck")?.name).toBe("ok");
  });

  it("どこも起動できないときは、いちばん先へ進んだ理由が出るホストを返す", () => {
    const offline = host({ name: "offline", online: false });
    const full = host({ name: "full", activeCount: REMOTE_SESSION_MAX_PER_HOST });
    expect(pickRemoteSessionHost([offline, full], "guchi-apps/issue-deck")?.name).toBe("full");
  });
});

describe("parseReportedRemoteSessions", () => {
  it("未申告（配列でない）はnullで、空配列と区別する", () => {
    expect(parseReportedRemoteSessions(undefined, parseRemoteControlUrl)).toBeNull();
    expect(parseReportedRemoteSessions([], parseRemoteControlUrl)).toEqual([]);
  });

  it("規約に合う名前だけを通し、claude.ai以外のURLは捨てる", () => {
    const parsed = parseReportedRemoteSessions(
      [
        { tmuxSessionName: "issue-deck-remote-abcd1234", remoteControlUrl: "https://claude.ai/code/session_x" },
        { tmuxSessionName: "issue-deck-remote-abcd1234" },
        { tmuxSessionName: "issue-deck-issue-12", remoteControlUrl: "https://claude.ai/code/y" },
        { tmuxSessionName: "vps-remote-zzzz9999", remoteControlUrl: "https://example.com/" },
      ],
      parseRemoteControlUrl,
    );
    expect(parsed).toEqual([
      { tmuxSessionName: "issue-deck-remote-abcd1234", remoteControlUrl: "https://claude.ai/code/session_x" },
      { tmuxSessionName: "vps-remote-zzzz9999", remoteControlUrl: null },
    ]);
  });
});

describe("parseIdleEndedRemoteSessions（#4871）", () => {
  it("未申告はnull、規約に合う名前だけを重複なく通す", () => {
    expect(parseIdleEndedRemoteSessions(undefined)).toBeNull();
    expect(
      parseIdleEndedRemoteSessions(["car-care-remote-r4wiv8se", "car-care-remote-r4wiv8se", "issue-deck-issue-1", 3]),
    ).toEqual(["car-care-remote-r4wiv8se"]);
  });
});

describe("selectHostRemoteSessions（#4836）", () => {
  const session = (overrides: Partial<RemoteSessionView>): RemoteSessionView => ({
    id: "s",
    repositoryFullName: "guchi-apps/issue-deck",
    host: "subpc",
    tmuxSessionName: "issue-deck-remote-abcdefgh",
    status: "running",
    remoteControlUrl: null,
    failureMessage: null,
    stopping: false,
    createdAt: "2026-10-18T00:00:00.000Z",
    lastSeenAt: null,
    ...overrides,
  });

  it("そのホストの終わっていないものだけを、起動の古い順に返す", () => {
    const result = selectHostRemoteSessions(
      [
        session({ id: "late", createdAt: "2026-10-18T02:00:00.000Z" }),
        session({ id: "other-host", host: "mainpc" }),
        session({ id: "ended", status: "ended" }),
        session({ id: "failed", status: "failed" }),
        session({ id: "early", status: "starting", createdAt: "2026-10-18T01:00:00.000Z" }),
      ],
      "subpc",
    );
    expect(result.map((item) => item.id)).toEqual(["early", "late"]);
  });
});

describe("再開の判定（#4874）", () => {
  it("一度でも動いた終了・失敗だけを再開できる", () => {
    const seen = "2026-10-20T00:00:00.000Z";
    expect(isRemoteSessionResumable({ status: "ended", lastSeenAt: seen })).toBe(true);
    expect(isRemoteSessionResumable({ status: "failed", lastSeenAt: seen })).toBe(true);
    expect(isRemoteSessionResumable({ status: "failed", lastSeenAt: null })).toBe(false);
    expect(isRemoteSessionResumable({ status: "running", lastSeenAt: seen })).toBe(false);
    expect(isRemoteSessionResumable({ status: "starting", lastSeenAt: seen })).toBe(false);
  });

  it("pollerの版数41以上だけを再開対応とみなす", () => {
    expect(supportsRemoteSessionResume("41")).toBe(true);
    expect(supportsRemoteSessionResume("42")).toBe(true);
    expect(supportsRemoteSessionResume("40")).toBe(false);
    expect(supportsRemoteSessionResume(null)).toBe(false);
    expect(supportsRemoteSessionResume("41-dev")).toBe(false);
  });
});

describe("summarizeRemoteSessionNav（#4948）", () => {
  it("終わっていないものを全ホスト合計で数え、起動中があれば立てる", () => {
    expect(
      summarizeRemoteSessionNav(
        [
          { status: "running", stopping: false },
          { status: "starting", stopping: false },
          { status: "running", stopping: true },
          { status: "ended", stopping: false },
          { status: "failed", stopping: false },
        ],
        true,
      ),
    ).toEqual({ count: 2, starting: true });
    expect(summarizeRemoteSessionNav([{ status: "running", stopping: false }], true)).toEqual({
      count: 1,
      starting: false,
    });
  });

  it("0本は0、取得前はnull", () => {
    expect(summarizeRemoteSessionNav([], true)).toEqual({ count: 0, starting: false });
    expect(summarizeRemoteSessionNav([{ status: "running", stopping: false }], false)).toEqual({ count: null, starting: false });
  });
});
