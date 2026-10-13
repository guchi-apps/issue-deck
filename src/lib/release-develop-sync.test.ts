import { describe, expect, it } from "vitest";

import {
  decideDevelopSync,
  developSyncBranchName,
  developSyncCreateError,
  developSyncMarker,
  isDevelopSyncHeadRef,
  parseDevelopSyncMarker,
  type DevelopSyncObservation,
} from "@/lib/release-develop-sync";

const MAIN = "a".repeat(40);
const DEV = "b".repeat(40);

const observed = (over: Partial<Extract<DevelopSyncObservation, { kind: "observed" }>> = {}): DevelopSyncObservation => ({
  kind: "observed",
  mainSha: MAIN,
  developSha: DEV,
  mainInDevelop: false,
  mainOnlyFiles: ["package.json", "src/lib/changelog.ts"],
  squashCoveredBy: null,
  openPullRequest: null,
  createFailure: null,
  ...over,
});

const pr = (over: Partial<NonNullable<Extract<DevelopSyncObservation, { kind: "observed" }>["openPullRequest"]>> = {}) => ({
  number: 50,
  url: "https://github.com/o/r/pull/50",
  headRef: developSyncBranchName(MAIN),
  mainSha: MAIN,
  ciState: "success" as const,
  mergeable: true,
  ...over,
});

describe("decideDevelopSync", () => {
  it("mainの先端がdevelopの祖先なら同期済み", () => {
    const status = decideDevelopSync(observed({ mainInDevelop: true, mainOnlyFiles: [] }));
    expect(status).toMatchObject({ state: "synced", detail: "ancestor", nextAction: null, canCreate: false });
  });

  it("mainにだけあるのがマージコミットだけ（変更ファイル0）なら同期済み（旧方式のリリース）", () => {
    expect(decideDevelopSync(observed({ mainOnlyFiles: [] }))).toMatchObject({ state: "synced", detail: "merge_commits_only" });
  });

  it("squashでマージ済みの同期PRが今のmainを含むなら同期済み（merge-baseが進まなくても未同期で固定しない）", () => {
    expect(decideDevelopSync(observed({ squashCoveredBy: 48 }))).toMatchObject({ state: "synced", detail: "squash_merged" });
  });

  it("mainにだけ変更があり同期PRが無ければ未同期で、作成を促す", () => {
    const status = decideDevelopSync(observed());
    expect(status).toMatchObject({ state: "unsynced", detail: "no_pull_request", canCreate: true });
    expect(status.reason).toContain("2ファイル");
  });

  it("作成に失敗したら理由を出し、再試行できる", () => {
    const status = decideDevelopSync(observed({ createFailure: "422 Validation Failed" }));
    expect(status).toMatchObject({ state: "unsynced", detail: "create_failed", canCreate: true });
    expect(status.reason).toContain("422 Validation Failed");
  });

  it("同期PRの競合・CI失敗・CI実行中・マージ待ちを区別し、作り直しは促さない（重複作成しない）", () => {
    expect(decideDevelopSync(observed({ openPullRequest: pr({ mergeable: false }) }))).toMatchObject({ detail: "conflict", canCreate: false });
    expect(decideDevelopSync(observed({ openPullRequest: pr({ ciState: "failure" }) }))).toMatchObject({ detail: "ci_failure" });
    expect(decideDevelopSync(observed({ openPullRequest: pr({ ciState: "pending" }) }))).toMatchObject({ detail: "ci_pending" });
    const waiting = decideDevelopSync(observed({ openPullRequest: pr({ mergeable: null, ciState: "unknown" }) }));
    expect(waiting).toMatchObject({ state: "unsynced", detail: "awaiting_merge", canCreate: false });
    expect(waiting.nextAction).toContain("#50");
  });

  it("競合の解消はmainへpushせず同期ブランチで行うと案内する", () => {
    const status = decideDevelopSync(observed({ openPullRequest: pr({ mergeable: false }) }));
    expect(status.nextAction).toContain(developSyncBranchName(MAIN));
    expect(status.nextAction).toContain("mainへは直接pushしません");
  });

  it("同期PRの作成後にmainが進んでいれば、その旨を出す", () => {
    const status = decideDevelopSync(observed({ openPullRequest: pr({ mainSha: "c".repeat(40) }) }));
    expect(status.reason).toContain("mainが進んだ");
  });

  it("取得できなければ判定不能（同期済みと推定しない）", () => {
    const status = decideDevelopSync({ kind: "unreadable", reason: "developの先端を取得できませんでした" });
    expect(status).toMatchObject({ state: "unknown", detail: "unreadable", canCreate: false });
  });
});

describe("developSyncCreateError", () => {
  it("同期済みだけ候補を作れる。未同期・判定不能は別の理由で断る", () => {
    expect(developSyncCreateError(decideDevelopSync(observed({ mainInDevelop: true, mainOnlyFiles: [] })))).toBeNull();
    expect(developSyncCreateError(decideDevelopSync(observed()))).toMatchObject({ error: "develop_not_synced" });
    expect(developSyncCreateError(decideDevelopSync({ kind: "unreadable", reason: "x" }))).toMatchObject({ error: "develop_sync_unknown" });
  });
});

describe("同期PRの識別", () => {
  it("ブランチ名と本文の印はmainのSHAで決まる", () => {
    expect(developSyncBranchName(MAIN)).toBe("release-sync/main-aaaaaaaaaaaa");
    expect(parseDevelopSyncMarker(`本文\n${developSyncMarker(MAIN)}`)).toBe(MAIN);
    expect(parseDevelopSyncMarker("<!-- issue-deck-develop-sync:v8.60.1 -->")).toBeNull();
  });

  it("専用ブランチと、以前のhead=mainの同期PRを同期PRとして扱う", () => {
    expect(isDevelopSyncHeadRef("release-sync/main-aaaaaaaaaaaa")).toBe(true);
    expect(isDevelopSyncHeadRef("main")).toBe(true);
    expect(isDevelopSyncHeadRef("issue-4641")).toBe(false);
  });
});
