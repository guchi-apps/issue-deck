import { describe, expect, it } from "vitest";

import { deployErrorMessage } from "@/lib/deploy-request";

describe("deployErrorMessage（#2020）", () => {
  it("deploy.ymlが無いリポジトリは、必要なファイル名まで言い切る", () => {
    expect(deployErrorMessage(400, "deploy_workflow_missing", undefined)).toContain("deploy.yml");
  });

  // 押し直しても直らないため、「何を足せば押せるか」まで書く
  it("手動起動に未対応なら、workflow_dispatchを足す必要があることを伝える", () => {
    const message = deployErrorMessage(400, "deploy_dispatch_unsupported", undefined);
    expect(message).toContain("workflow_dispatch");
  });

  it("GitHub API側の失敗はそのままの文言を出す", () => {
    expect(deployErrorMessage(502, "github_api_error", "422 unprocessable")).toBe(
      "422 unprocessable",
    );
  });

  it("知らないエラーコードはステータスを添えて返す", () => {
    expect(deployErrorMessage(500, "boom", undefined)).toBe("リクエストに失敗しました (500)");
  });
});
