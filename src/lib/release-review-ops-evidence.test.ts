import { describe, expect, it } from "vitest";

import {
  assessReleaseOps,
  findOpsRequest,
  type ReleaseOpsContext,
  type ReleaseOpsHostFact,
} from "@/lib/release-review-ops-evidence";

const host = (overrides: Partial<ReleaseOpsHostFact> = {}): ReleaseOpsHostFact => ({
  name: "subpc",
  online: true,
  startedCommit: "abc1234",
  commit: "abc1234",
  releaseVerifyCapable: true,
  releaseReviewCapable: true,
  lastSelfUpdateAt: null,
  includesCandidate: null,
  ...overrides,
});

const ctx = (overrides: Partial<ReleaseOpsContext> = {}): ReleaseOpsContext => ({
  repositoryFullName: "guchi-apps/issue-deck",
  changedFiles: ["scripts/subpc-dispatch-poller.sh", "src/lib/a.ts"],
  hosts: [host()],
  ...overrides,
});

const request = findOpsRequest(["host_compat: サブPCのpoller更新・再起動の証跡が未確認"]);

describe("findOpsRequest", () => {
  it("更新・再起動を要求する文だけを拾う", () => {
    expect(findOpsRequest(["旧poller更新・再起動の証跡未確認"])).not.toBeNull();
    expect(findOpsRequest(["新しいプロンプトはpollerの更新後に有効"])).not.toBeNull();
  });

  it("pollerへの言及だけ・互換性の確認・更新済み・更新不要の記述は要求にしない", () => {
    expect(findOpsRequest(["pollerの互換性を確認した（旧pollerでも動作する）"])).toBeNull();
    expect(findOpsRequest(["サブPCのpollerは更新済み"])).toBeNull();
    expect(findOpsRequest(["方針はサーバー配布のためpollerの更新は不要"])).toBeNull();
    expect(findOpsRequest(["pollerの処理を読んだ"])).toBeNull();
    expect(findOpsRequest([null, "テストが未確認"])).toBeNull();
  });

  it("参照しているIssue番号と非互換の記述を拾う", () => {
    const r = findOpsRequest(["pollerが旧版だと動かなくなるため更新が必要（#4118）"]);
    expect(r).toMatchObject({ incompatible: true, relatedIssues: [4118] });
  });
});

describe("assessReleaseOps", () => {
  it("要求が無ければ案内しない", () => {
    expect(assessReleaseOps(null, ctx())).toBeNull();
  });

  it("サーバー側だけで有効になる候補には、サブPCの更新を求めない", () => {
    const r = assessReleaseOps(request, ctx({ changedFiles: ["src/lib/a.ts", "docs/x.md"] }));
    expect(r).toMatchObject({ status: "not_needed", timing: null });
  });

  it("稼働コミットが候補を含むなら更新済み", () => {
    const r = assessReleaseOps(request, ctx({ hosts: [host({ includesCandidate: true })] }));
    expect(r?.status).toBe("updated");
  });

  it("旧版で候補を含まないなら更新が必要。非互換の根拠が無ければ公開後でよい", () => {
    const r = assessReleaseOps(request, ctx({ hosts: [host({ includesCandidate: false })] }));
    expect(r).toMatchObject({ status: "needed", timing: "after_release", hosts: ["subpc"] });
    expect(r?.nextAction).toContain("更新して再起動");
    expect(r?.nextAction).toContain("止める理由にはなりません");
  });

  it("非互換の根拠があれば公開前に更新", () => {
    const r = assessReleaseOps(
      findOpsRequest(["旧pollerだと動かなくなるため、pollerの更新が必要"]),
      ctx({ hosts: [host({ includesCandidate: false })] }),
    );
    expect(r).toMatchObject({ status: "needed", timing: "before_release" });
  });

  it("取得できない事実は、更新必須にも更新済みにもしない", () => {
    expect(assessReleaseOps(request, null)?.status).toBe("unknown");
    expect(assessReleaseOps(request, ctx({ changedFiles: null }))?.status).toBe("unknown");
    expect(assessReleaseOps(request, ctx({ hosts: [] }))?.status).toBe("unknown");
    expect(assessReleaseOps(request, ctx({ hosts: [host({ online: false, includesCandidate: false })] }))?.status).toBe(
      "unknown",
    );
    expect(assessReleaseOps(request, ctx({ hosts: [host({ includesCandidate: null })] }))?.status).toBe("unknown");
  });

  it("他リポジトリはチェックアウトの遅れではなく、必要な能力の申告で決める", () => {
    const other = { repositoryFullName: "guchi-apps/car-care", changedFiles: null };
    expect(assessReleaseOps(request, ctx({ ...other, hosts: [host()] }))?.status).toBe("updated");
    expect(
      assessReleaseOps(request, ctx({ ...other, hosts: [host({ releaseReviewCapable: false })] })),
    ).toMatchObject({ status: "needed", timing: "before_release" });
    expect(assessReleaseOps(request, ctx({ ...other, hosts: [] }))?.status).toBe("unknown");
  });
});
