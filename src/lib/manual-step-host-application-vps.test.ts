import { beforeEach, describe, expect, it, vi } from "vitest";

const { hostFindMany, jobFindMany } = vi.hoisted(() => ({
  hostFindMany: vi.fn(),
  jobFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { dispatchHost: { findMany: hostFindMany }, dispatchJob: { findMany: jobFindMany } },
}));

import { listManualStepHostApplications } from "./manual-step-host-application";

const body = (device: string) => `## 前提条件\n\n- 実行するデバイス: ${device}\n\n## やること\n- [ ] （${device}・全ホスト）手順\n\n## 完了の確認方法\n\n\`\`\`bash\ntrue\n\`\`\`\n`;

describe("全ホスト手作業のVPS手順の対象ホスト（#5587）", () => {
  beforeEach(() => {
    hostFindMany.mockResolvedValue([
      { name: "deskmini", manualStepVpsCapable: false },
      { name: "macmini", manualStepVpsCapable: true },
    ]);
    jobFindMany.mockResolvedValue([
      { repositoryFullName: "o/r", issueNumber: 1, command: "true", targetHost: "macmini" },
    ]);
  });

  it("VPS手順はVPS対応のホストだけを数え、非対応ホストで永遠に未適用にしない", async () => {
    const map = await listManualStepHostApplications([
      { repositoryFullName: "o/r", number: 1, body: body("VPS") },
    ]);
    expect(map.get("o/r#1")).toEqual([{ host: "macmini", applied: true }]);
  });

  it("ローカル手順は従来どおり全ホストを数える", async () => {
    const map = await listManualStepHostApplications([
      { repositoryFullName: "o/r", number: 1, body: body("ローカル") },
    ]);
    expect(map.get("o/r#1")?.map((e) => e.host)).toEqual(["deskmini", "macmini"]);
  });
});
