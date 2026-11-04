// 証明書の掃除が実際の応答の形で対象を選べること、他アプリの掃除と競合しても配布を止めないことを固定する（#5208）。
import { describe, expect, it, vi } from "vitest";

import { pickApiCreatedDevCertificates, revokeApiDevCerts } from "./asc-api.mjs";

// 実際の応答の形: name は種別の接頭辞付き、displayName が素の名前
const cert = (id, displayName, certificateType, prefix = "Apple Development") => ({
  id,
  attributes: { name: `${prefix}: ${displayName}`, displayName, certificateType },
});

describe("pickApiCreatedDevCertificates", () => {
  it("API作成のDevelopment証明書だけを選ぶ（自分用・Distributionは残す）", () => {
    const picked = pickApiCreatedDevCertificates([
      cert("1", "Created via API", "DEVELOPMENT"),
      cert("2", "Created via API", "IOS_DEVELOPMENT", "iOS Development"),
      cert("3", "Mac User", "DEVELOPMENT"),
      cert("4", "Created via API", "DISTRIBUTION", "Apple Distribution"),
      cert("5", "Created via API", "IOS_DISTRIBUTION", "iPhone Distribution"),
    ]);
    expect(picked.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("接頭辞付きの name だけでは選ばない", () => {
    const picked = pickApiCreatedDevCertificates([
      { id: "6", attributes: { name: "Apple Development: Created via API", certificateType: "DEVELOPMENT" } },
    ]);
    expect(picked).toEqual([]);
  });
});

describe("revokeApiDevCerts", () => {
  const clientWith = (certs, onDelete = async () => ({})) => ({
    request: vi.fn(async (method, path) => {
      if (method === "GET") return { data: certs };
      return onDelete(path);
    }),
  });
  const deletedPaths = (client) =>
    client.request.mock.calls.filter(([method]) => method === "DELETE").map(([, path]) => path);

  it("対象だけを失効させる", async () => {
    const client = clientWith([cert("1", "Created via API", "DEVELOPMENT"), cert("2", "Mac User", "DEVELOPMENT")]);
    await revokeApiDevCerts(client, { dryRun: false });
    expect(deletedPaths(client)).toEqual(["/v1/certificates/1"]);
  });

  it("dry-runでは失効させない", async () => {
    const client = clientWith([cert("1", "Created via API", "DEVELOPMENT")]);
    await revokeApiDevCerts(client, { dryRun: true });
    expect(deletedPaths(client)).toEqual([]);
  });

  it("他アプリの掃除に先を越された証明書（404）は飛ばして続ける", async () => {
    const client = clientWith(
      [cert("1", "Created via API", "DEVELOPMENT"), cert("2", "Created via API", "DEVELOPMENT")],
      async (path) => {
        if (path.endsWith("/1")) throw new Error(`App Store Connect API DELETE ${path} が HTTP 404: not found`);
        return {};
      }
    );
    await revokeApiDevCerts(client, { dryRun: false });
    expect(deletedPaths(client)).toEqual(["/v1/certificates/1", "/v1/certificates/2"]);
  });

  it("404以外の失敗は握り潰さない", async () => {
    const client = clientWith([cert("1", "Created via API", "DEVELOPMENT")], async (path) => {
      throw new Error(`App Store Connect API DELETE ${path} が HTTP 500: error`);
    });
    await expect(revokeApiDevCerts(client, { dryRun: false })).rejects.toThrow("HTTP 500");
  });
});
