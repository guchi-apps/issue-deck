import { describe, expect, it } from "vitest";

import { describePublishSteps, type PublishStepsInput } from "@/lib/release-publish-steps";

type Approval = NonNullable<PublishStepsInput["approval"]>;

function approval(over: Partial<Approval> = {}): Approval {
  return {
    status: "active",
    approvedAt: "2026-10-18T14:38:00Z",
    mergeSha: null,
    invalidMessage: null,
    progress: "auto_publish",
    progressLabel: "自動公開待ち",
    run: { stopMessage: null, waitMessage: "CIの完了を待っています", mergedAt: null },
    ...over,
  };
}

const states = (view: ReturnType<typeof describePublishSteps>) => view?.steps.map((s) => `${s.key}:${s.state}`);

describe("describePublishSteps（#4814）", () => {
  it("承認の記録が無ければ出さない（従来の検証ピルに任せる）", () => {
    expect(describePublishSteps({ approval: null, finalization: null })).toBeNull();
    expect(describePublishSteps({ approval: approval({ progress: "needs_approval" }), finalization: null })).toBeNull();
  });

  it("自動公開待ちは進行中のピルで、mainへは未マージと待っている理由を出す", () => {
    const view = describePublishSteps({ approval: approval(), finalization: { status: "applied" } });
    expect(view?.pill).toEqual({ label: "自動公開の条件を確認中", tone: "run" });
    expect(states(view)).toEqual([
      "approved:done",
      "bumped:done",
      "merged:current",
      "deploying:todo",
      "verifying:todo",
      "completed:todo",
    ]);
    expect(view?.steps[0].at).toBe("2026-10-18T14:38:00Z");
    expect(view?.steps[2].label).toBe("mainへマージ待ち");
    expect(view?.merged).toBe(false);
    expect(view?.note).toBe("mainへは未マージです。条件が揃うと自動でマージします（CIの完了を待っています）");
  });

  it("最終検証中はバンプの段に居る", () => {
    const view = describePublishSteps({
      approval: approval({ progress: "final_checks", progressLabel: "最終検証中" }),
      finalization: { status: "requested" },
    });
    expect(view?.pill).toEqual({ label: "最終検証中", tone: "run" });
    expect(view?.steps[1]).toMatchObject({ state: "current", label: "正式バンプ・最終検証" });
  });

  it("マージを確保中（merging）でマージSHAが無ければ、まだmainへ入ったとは言わない", () => {
    const view = describePublishSteps({
      approval: approval({ status: "merging", progress: "deploying", progressLabel: "本番反映中" }),
      finalization: { status: "applied" },
    });
    expect(view?.pill).toEqual({ label: "mainへマージ中", tone: "run" });
    expect(view?.steps[2]).toMatchObject({ state: "current", label: "mainへマージ中" });
    expect(view?.merged).toBe(false);
  });

  it("mainへマージ済みならマージ時刻を添え、本番反映中を出す", () => {
    const view = describePublishSteps({
      approval: approval({
        status: "consumed",
        mergeSha: "a".repeat(40),
        progress: "deploying",
        progressLabel: "本番反映中",
        run: { stopMessage: null, mergedAt: "2026-10-18T14:52:00Z" },
      }),
      finalization: { status: "applied" },
    });
    expect(view?.pill).toEqual({ label: "本番反映中", tone: "run" });
    expect(view?.steps[2]).toMatchObject({ state: "done", label: "mainへマージ済み", at: "2026-10-18T14:52:00Z" });
    expect(view?.steps[3].state).toBe("current");
    expect(view?.note).toBeNull();
  });

  it("完了は全段済みの緑", () => {
    const view = describePublishSteps({
      approval: approval({ status: "consumed", mergeSha: "b".repeat(40), progress: "completed", progressLabel: "完了" }),
      finalization: { status: "applied" },
    });
    expect(view?.pill.tone).toBe("ok");
    expect(view?.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("停止・失効は止まった段を赤で示し、理由を出す", () => {
    const stopped = describePublishSteps({
      approval: approval({
        progress: "stopped",
        progressLabel: "自動公開が停止",
        run: { stopMessage: "CIが失敗しました", mergedAt: null },
      }),
      finalization: { status: "applied" },
    });
    expect(stopped?.pill).toEqual({ label: "自動公開が停止", tone: "bad" });
    expect(stopped?.steps[2].state).toBe("stopped");
    expect(stopped?.note).toBe("CIが失敗しました");
    const invalidated = describePublishSteps({
      approval: approval({
        status: "invalidated",
        progress: "invalidated",
        progressLabel: "公開承認が失効",
        invalidMessage: "承認した後にmainが進みました",
      }),
      finalization: null,
    });
    expect(invalidated?.pill.tone).toBe("bad");
    expect(invalidated?.steps[1].state).toBe("stopped");
    expect(invalidated?.note).toBe("承認した後にmainが進みました");
  });
});
