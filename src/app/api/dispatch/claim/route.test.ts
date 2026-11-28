import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const claimDispatchJobs = vi.fn();
const sweepCheckUserPushNotifications = vi.fn();
const appSettingFindUnique = vi.fn();
const jobFindMany = vi.fn();
const jobUpdateMany = vi.fn();

vi.mock("@/lib/dispatch/jobs", () => ({
  get claimDispatchJobs() {
    return claimDispatchJobs;
  },
}));

vi.mock("@/lib/notifications/check-user-push", () => ({
  get sweepCheckUserPushNotifications() {
    return sweepCheckUserPushNotifications;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return appSettingFindUnique;
      },
    },
    dispatchJob: {
      get findMany() {
        return jobFindMany;
      },
      get updateMany() {
        return jobUpdateMany;
      },
    },
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization = "Bearer secret-value") {
  return new Request("http://localhost/api/dispatch/claim", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  claimDispatchJobs.mockResolvedValue([]);
  sweepCheckUserPushNotifications.mockResolvedValue(undefined);
  appSettingFindUnique.mockResolvedValue({ claudeLocalModel: "sonnet", codexModel: "auto" });
  jobFindMany.mockResolvedValue([]);
  jobUpdateMany.mockResolvedValue({ count: 0 });
});

describe("POST /api/dispatch/claim", () => {
  it("DISPATCH_SECRET未設定なら503（値の不一致と区別できるようにする）", async () => {
    delete process.env.DISPATCH_SECRET;
    const res = await POST(postRequest({ host: "subpc" }));
    expect(res.status).toBe(503);
    expect(claimDispatchJobs).not.toHaveBeenCalled();
  });

  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest({ host: "subpc" }, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(claimDispatchJobs).not.toHaveBeenCalled();
  });

  it("ホスト名が無ければ400", async () => {
    const res = await POST(postRequest({ maxJobs: 1 }));
    expect(res.status).toBe(400);
    expect(claimDispatchJobs).not.toHaveBeenCalled();
  });

  // 通常の巡回（30秒に1回）。相乗りしている確認待ちPush通知の巡回（#838）はここで回る
  it("通常の巡回では確認待ちPush通知の巡回も1歩進める", async () => {
    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));
    expect(res.status).toBe(200);
    expect(sweepCheckUserPushNotifications).toHaveBeenCalledTimes(1);
    expect(claimDispatchJobs).toHaveBeenCalledWith({ hostName: "subpc", maxJobs: 1 });
  });

  // 軽い巡回（#2413）は数秒間隔で来る。30秒に1回来る前提で相乗りさせた処理を、
  // そのまま10倍回さない
  it("fast: true では相乗りの巡回を省き、払い出しはそのまま行う", async () => {
    const res = await POST(postRequest({ host: "subpc", maxJobs: 0, fast: true }));
    expect(res.status).toBe(200);
    expect(sweepCheckUserPushNotifications).not.toHaveBeenCalled();
    expect(claimDispatchJobs).toHaveBeenCalledWith({ hostName: "subpc", maxJobs: 0 });
    expect(appSettingFindUnique).not.toHaveBeenCalled();
  });

  // 相乗りの巡回が落ちても払い出しは続ける（#838のときからの約束）
  // 計画レビューの空き本数（#3772）。送ってきたpollerにだけ別枠で配る
  it("planReviewMaxJobsを受け取ったら払い出しへ渡す", async () => {
    await POST(postRequest({ host: "subpc", maxJobs: 0, planReviewMaxJobs: 2 }));
    expect(claimDispatchJobs).toHaveBeenCalledWith({
      hostName: "subpc",
      maxJobs: 0,
      planReviewMaxJobs: 2,
    });
  });

  it.each([["負数", -1], ["小数", 1.5], ["文字列", "2"]])(
    "planReviewMaxJobsが%sなら未指定として扱う（従来どおり起動枠で配る）",
    async (_label, value) => {
      await POST(postRequest({ host: "subpc", maxJobs: 1, planReviewMaxJobs: value }));
      expect(vi.mocked(claimDispatchJobs).mock.calls.at(-1)?.[0].planReviewMaxJobs).toBeUndefined();
    },
  );

  it("相乗りの巡回が失敗してもジョブは払い出す", async () => {
    sweepCheckUserPushNotifications.mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    claimDispatchJobs.mockResolvedValue([{ id: "job-1" }]);

    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      jobs: [{ id: "job-1", claudeLocalModel: "sonnet", codexModel: "auto" }],
    });
    consoleError.mockRestore();
  });

  it("保存済みのCodexモデルを払い出すジョブへ付ける", async () => {
    claimDispatchJobs.mockResolvedValue([{ id: "job-1" }]);
    appSettingFindUnique.mockResolvedValue({
      claudeLocalModel: "opus",
      codexModel: "gpt-6.1-terra",
    });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));

    expect(await res.json()).toEqual({
      ok: true,
      jobs: [{ id: "job-1", claudeLocalModel: "opus", codexModel: "gpt-6.1-terra" }],
    });
  });

  // #3106。設定が「おまかせ」でも、pollerへ`pick`は渡さない（ランチャーが`--model pick`で起動して
  // しまうため）。ダイアログを経由しない起動はSonnetで立てる
  it("設定がおまかせ（pick）でモデル指定の無いジョブは、Sonnetで払い出す", async () => {
    claimDispatchJobs.mockResolvedValue([
      { id: "job-1", claudeModel: null },
      { id: "job-2", claudeModel: "opus" },
    ]);
    appSettingFindUnique.mockResolvedValue({ claudeLocalModel: "pick", codexModel: "auto" });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 2 }));

    const body = await res.json();
    expect(body.jobs.map((job: { claudeLocalModel: string }) => job.claudeLocalModel)).toEqual([
      "sonnet",
      "opus",
    ]);
  });

  // #2717。**pollerは`claudeLocalModel`しか読まない**ので、Issueごとの指定はここで
  // 差し替えて届ける（poller側の変更が要らないのがこの持たせ方の要点）
  it("ジョブにモデルの指定があれば、設定の既定より優先して払い出す", async () => {
    claimDispatchJobs.mockResolvedValue([
      { id: "job-1", claudeModel: "fable" },
      { id: "job-2", claudeModel: null },
    ]);
    appSettingFindUnique.mockResolvedValue({
      claudeLocalModel: "sonnet",
      codexModel: "gpt-6.1-terra",
    });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 2 }));

    expect(await res.json()).toEqual({
      ok: true,
      jobs: [
        {
          id: "job-1",
          claudeModel: "fable",
          claudeLocalModel: "fable",
          codexModel: "gpt-6.1-terra",
        },
        {
          id: "job-2",
          claudeModel: null,
          claudeLocalModel: "sonnet",
          codexModel: "gpt-6.1-terra",
        },
      ],
    });
  });
  // #3192。Claudeと同じく**pollerは`codexModel`しか読まない**ので、Issueごとの指定はここで
  // 差し替えて届ける
  it("ジョブにCodexのモデルの指定があれば、設定の既定より優先して払い出す", async () => {
    claimDispatchJobs.mockResolvedValue([
      { id: "job-1", agent: "codex", codexModel: "gpt-6.2-astra" },
      { id: "job-2", agent: "codex", codexModel: null },
    ]);
    appSettingFindUnique.mockResolvedValue({
      claudeLocalModel: "sonnet",
      codexModel: "gpt-6.2-sol",
    });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 2 }));

    const body = await res.json();
    expect(body.jobs.map((job: { codexModel: string }) => job.codexModel)).toEqual([
      "gpt-6.2-astra",
      "gpt-6.2-sol",
    ]);
  });

  // 設定が「おまかせ」でも`-m pick`で起動させない。ダイアログを経由しない起動はTerraで立てる
  it("設定がおまかせ（pick）でCodexのモデル指定の無いジョブは、Terraで払い出す", async () => {
    claimDispatchJobs.mockResolvedValue([{ id: "job-1", agent: "codex", codexModel: null }]);
    appSettingFindUnique.mockResolvedValue({ claudeLocalModel: "sonnet", codexModel: "pick" });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));

    expect((await res.json()).jobs[0].codexModel).toBe("gpt-6.1-terra");
  });

  // ジョブの列を手で書き換えられても、pollerへ届く語は既知のものだけ
  it("ジョブのCodexモデルが未知の語なら、設定の既定へ倒す", async () => {
    claimDispatchJobs.mockResolvedValue([{ id: "job-1", agent: "codex", codexModel: "opus" }]);
    appSettingFindUnique.mockResolvedValue({ claudeLocalModel: "sonnet", codexModel: "gpt-6-luna" });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));

    expect((await res.json()).jobs[0].codexModel).toBe("gpt-6-luna");
  });
});

// #5674。サーバーの公開がホストの更新より先でも、旧pollerのジョブが失敗しないこと
describe("POST /api/dispatch/claim の旧pollerへのCodexモデルの読み替え（#5674）", () => {
  const codexModelsFor = async (payload: object, kind: string) => {
    claimDispatchJobs.mockResolvedValue(
      ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna", null].map((model, index) => ({
        id: `job-${index}`,
        kind,
        agent: "codex",
        codexModel: model,
      })),
    );
    appSettingFindUnique.mockResolvedValue({ claudeLocalModel: "sonnet", codexModel: "pick" });
    const res = await POST(postRequest({ host: "subpc", maxJobs: 5, ...payload }));
    const body = await res.json();
    return body.jobs.map((job: { codexModel: string }) => job.codexModel);
  };

  it.each(["LAUNCH", "PLAN_REVIEW"])(
    "申告の無いpollerへの%sは、同格の旧世代IDで払い出す（設定の既定も含む）",
    async (kind) => {
      expect(await codexModelsFor({}, kind)).toEqual([
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-5.6-terra",
        "gpt-6-luna",
        "gpt-5.6-terra",
      ]);
    },
  );

  const latest = ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-terra"];

  it("申告したpollerへは新世代のIDのまま払い出す", async () => {
    expect(await codexModelsFor({ gpt61CodexModels: true }, "LAUNCH")).toEqual(latest);
  });

  it("旧pollerもIDを検査しない種別は読み替えない", async () => {
    expect(await codexModelsFor({}, "RELEASE_REVIEW")).toEqual(latest);
  });

  // 申告を送り忘れると、更新後のホストもずっと旧世代で起動する
  it("pollerは起動ジョブを取りに行くときに対応を申告する", () => {
    const poller = readFileSync("scripts/subpc-dispatch-poller.sh", "utf8");
    expect(poller).toContain("planReviewMaxJobs: $planReviewMaxJobs, gpt61CodexModels: true}");
  });
});

describe("POST /api/dispatch/claim のリモートセッションの最初の指示（#5405）", () => {
  it("REMOTE_SESSIONジョブにだけ指示を付け、払い出した直後に列を空にする", async () => {
    claimDispatchJobs.mockResolvedValue([
      { id: "j1", kind: "REMOTE_SESSION" },
      { id: "j2", kind: "REMOTE_SESSION" },
      { id: "j3", kind: "LAUNCH" },
    ]);
    jobFindMany.mockResolvedValue([{ id: "j1", initialPrompt: "調べて" }]);
    const res = await POST(postRequest({ host: "subpc", maxJobs: 3 }));
    const body = await res.json();
    expect(body.jobs.find((job: { id: string }) => job.id === "j1").initialPrompt).toBe("調べて");
    expect(body.jobs.find((job: { id: string }) => job.id === "j2")).not.toHaveProperty("initialPrompt");
    expect(body.jobs.find((job: { id: string }) => job.id === "j3")).not.toHaveProperty("initialPrompt");
    // 引くのはREMOTE_SESSIONのidだけ
    expect(jobFindMany.mock.calls[0][0].where.id).toEqual({ in: ["j1", "j2"] });
    expect(jobUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["j1"] } }, data: { initialPrompt: null } });
  });

  it("指示を持つジョブが無ければ列を触らない", async () => {
    claimDispatchJobs.mockResolvedValue([{ id: "j3", kind: "LAUNCH" }]);
    await POST(postRequest({ host: "subpc", maxJobs: 1 }));
    expect(jobFindMany).not.toHaveBeenCalled();
    expect(jobUpdateMany).not.toHaveBeenCalled();
  });
});
