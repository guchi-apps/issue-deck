import { beforeEach, describe, expect, it, vi } from "vitest";

const recordSecretsSyncReport = vi.fn();

vi.mock("@/lib/secrets-sync-runs", () => ({
  get recordSecretsSyncReport() {
    return recordSecretsSyncReport;
  },
}));

const { POST } = await import("./route");

function reportRequest(body: unknown, token = "test-secret") {
  return new Request("http://localhost/api/secrets-sync/report", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const payload = {
  repository: "guchi-apps/car-care",
  runUrl: "https://github.com/guchi-apps/car-care/actions/runs/1",
  only: "",
  succeeded: true,
  synced: 2,
  skipped: 1,
  failed: 1,
  failedKeys: ["DEPLOY_SSH_KEY"],
  syncedKeys: ["APP_BASE_URL", "DB_NAME"],
  skippedKeys: ["WORKFLOW_PAT"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PROGRESS_REPORT_SECRET", "test-secret");
});

describe("POST /api/secrets-sync/report", () => {
  it("同期・スキップ・失敗の項目名を、名前だけ受け取って記録する（#2022）", async () => {
    const res = await POST(reportRequest(payload));

    expect(res.status).toBe(200);
    expect(recordSecretsSyncReport).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "guchi-apps/car-care",
        failedKeys: ["DEPLOY_SSH_KEY"],
        syncedKeys: ["APP_BASE_URL", "DB_NAME"],
        skippedKeys: ["WORKFLOW_PAT"],
      }),
    );
  });

  it("KEY名として妥当でない要素は落とすが、報告全体は捨てない", async () => {
    await POST(
      reportRequest({ ...payload, syncedKeys: ["DB_NAME", "op://apps/Server/host", ""] }),
    );

    expect(recordSecretsSyncReport).toHaveBeenCalledWith(
      expect.objectContaining({ syncedKeys: ["DB_NAME"], synced: 2 }),
    );
  });

  it("項目名を送らない古いワークフローからの報告も、そのまま受ける", async () => {
    await POST(
      reportRequest({
        repository: "guchi-apps/car-care",
        succeeded: true,
        synced: 2,
        skipped: 1,
        failed: 0,
        failedKeys: [],
      }),
    );

    expect(recordSecretsSyncReport).toHaveBeenCalledWith(
      expect.objectContaining({ syncedKeys: [], skippedKeys: [], synced: 2 }),
    );
  });

  it("共有シークレットが合わなければ記録しない", async () => {
    const res = await POST(reportRequest(payload, "wrong-secret"));

    expect(res.status).toBe(401);
    expect(recordSecretsSyncReport).not.toHaveBeenCalled();
  });
});
