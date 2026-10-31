import { describe, expect, it } from "vitest";

import {
  decideDevelopSync,
  decideDevelopSyncAutoMerge,
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

describe("decideDevelopSyncAutoMerge（#4669・#5081）", () => {
  const ready = (over: Parameters<typeof pr>[0] = {}) =>
    pr({ headSha: MAIN, body: "", labels: [], reviewSettled: true, ...over });
  const main = (files = ["package.json", "src/a.ts"]) => ({ sha: MAIN, files });
  const WORKFLOW = ".github/workflows/collection-daily.yml";

  it("条件を満たせばHEADを指定してマージする", () => {
    expect(decideDevelopSyncAutoMerge(ready(), main())).toEqual({ ok: true, headSha: MAIN });
  });

  it("条件の成立待ち（巡回が待つ）と人の対応が要る停止を分ける", () => {
    expect(decideDevelopSyncAutoMerge(ready({ ciState: "pending" }), main())).toMatchObject({ ok: false, waiting: true });
    expect(decideDevelopSyncAutoMerge(ready({ mergeable: null }), main())).toMatchObject({ ok: false, waiting: true });
    expect(decideDevelopSyncAutoMerge(ready({ reviewSettled: false }), main())).toMatchObject({ ok: false, waiting: true });
    expect(decideDevelopSyncAutoMerge(ready({ ciState: "failure" }), main())).toMatchObject({ ok: false, waiting: false });
    expect(decideDevelopSyncAutoMerge(ready({ mergeable: false }), main())).toMatchObject({ ok: false, waiting: false });
    expect(decideDevelopSyncAutoMerge(ready({ labels: ["22.merge-confirm-required"] }), main())).toMatchObject({ ok: false, waiting: false });
    expect(decideDevelopSyncAutoMerge(ready({ headSha: "h".repeat(40) }), main())).toMatchObject({ ok: false, waiting: false });
    expect(decideDevelopSyncAutoMerge(ready({ mainSha: "c".repeat(40), headSha: "c".repeat(40) }), main())).toMatchObject({ ok: false, waiting: false });
  });

  it("ワークフローを含むときは、今のmainと一致する公開の記録と、そのマージでの変更を要求する", () => {
    const files = ["package.json", WORKFLOW];
    expect(decideDevelopSyncAutoMerge(ready(), main(files))).toMatchObject({ ok: false, waiting: false });
    expect(decideDevelopSyncAutoMerge(ready(), main(files), { publishedMergeSha: "c".repeat(40), mergeChangedFiles: files })).toMatchObject({
      ok: false,
      waiting: false,
    });
    expect(decideDevelopSyncAutoMerge(ready(), main(files), { publishedMergeSha: MAIN, mergeChangedFiles: ["package.json"] })).toMatchObject({
      ok: false,
      waiting: false,
    });
    expect(decideDevelopSyncAutoMerge(ready(), main(files), { publishedMergeSha: MAIN, mergeChangedFiles: null })).toMatchObject({ ok: false, waiting: false });
    expect(decideDevelopSyncAutoMerge(ready(), main(files), { publishedMergeSha: MAIN, mergeChangedFiles: files })).toEqual({ ok: true, headSha: MAIN });
  });

  it("証跡があっても、CI・レビュー・確認ラベルの保護は緩めない", () => {
    const files = ["package.json", WORKFLOW];
    const evidence = { publishedMergeSha: MAIN, mergeChangedFiles: files };
    expect(decideDevelopSyncAutoMerge(ready({ ciState: "failure" }), main(files), evidence).ok).toBe(false);
    expect(decideDevelopSyncAutoMerge(ready({ labels: ["00.check-user"] }), main(files), evidence).ok).toBe(false);
    expect(decideDevelopSyncAutoMerge(ready({ headSha: "h".repeat(40) }), main(files), evidence).ok).toBe(false);
  });

  it("CIの実行中はGitHubのオートマージへ任せず待つ。人の対応が要る理由が確定していれば人へ回す（#5151）", () => {
    expect(decideDevelopSyncAutoMerge(ready({ ciState: "pending", reviewSettled: false }), main())).toEqual({
      ok: false,
      waiting: true,
      reason: "CIの完了を待っています",
    });
    for (const over of [{ labels: ["00.check-user"] }, { headSha: "h".repeat(40) }]) {
      expect(decideDevelopSyncAutoMerge(ready({ ciState: "pending", ...over }), main())).toMatchObject({ ok: false, waiting: false });
    }
    expect(decideDevelopSyncAutoMerge(ready({ ciState: "pending" }), main(["package.json", WORKFLOW]))).toMatchObject({ ok: false, waiting: false });
    const pending = decideDevelopSync(observed({ openPullRequest: ready({ ciState: "pending" }) }));
    expect(pending.detail).toBe("ci_pending");
    expect(pending.reason).not.toContain("オートマージ");
    const heldWhilePending = decideDevelopSync(observed({ openPullRequest: ready({ ciState: "pending", labels: ["00.check-user"] }) }));
    expect(heldWhilePending.detail).toBe("merge_held");
  });

  it("同期状態では、人の対応が要る停止を「人の確認が必要」として理由と次の操作を出す", () => {
    const held = decideDevelopSync(observed({ openPullRequest: ready({ labels: ["00.check-user"] }) }));
    expect(held).toMatchObject({ state: "unsynced", detail: "merge_held", label: "同期PRは人の確認が必要です" });
    expect(held.reason).toContain("00.check-user");
    expect(held.nextAction).toContain("マージコミットでマージ");
    const auto = decideDevelopSync(observed({ openPullRequest: ready({ reviewSettled: false }) }));
    expect(auto).toMatchObject({ detail: "awaiting_merge", label: "同期PRの自動マージ待ちです" });
    expect(auto.nextAction).toContain("操作は不要です");
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
