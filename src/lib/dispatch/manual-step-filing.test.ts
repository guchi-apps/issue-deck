import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));

import { manualStepKeyMarker, parseManualStepRequests, renderFilingComment } from "@/lib/dispatch/manual-step-filing";

const validBody = [
  "## この作業でできるようになること",
  "- 検証DBで画面を確認できる。実行するまでは確認できない。",
  "",
  "## 前提条件",
  "- 実行するデバイス: サブPC",
  "- カレントディレクトリ: ~/apps/asset-manager",
  "- Gitブランチ: develop",
  "- 先に完了している必要があるIssue・PR: guchi-apps/asset-manager#699",
  "",
  "## やること",
  "- [ ] （サブPC）DBを作る",
  "  ```bash",
  "  cd ~/apps/asset-manager && echo create-db",
  "  ```",
  "",
  "## 完了の確認方法",
  "```bash",
  "cd ~/apps/asset-manager && test -f .db-created",
  "```",
  "",
  "## なぜエージェントが実施しないか",
  "- 本番DBの作成権限が必要なため。",
  "",
  "## 関連",
  "- 起点Issue: guchi-apps/asset-manager#698",
].join("\n");

const base = { key: "create-verify-db", targetRepository: "guchi-apps/asset-manager", title: "[手作業] サブPC: 検証DBを作る", body: validBody };

describe("parseManualStepRequests", () => {
  it("空・件数超過・不正なkeyを拒否する", () => {
    expect(parseManualStepRequests([]).error).toBeTruthy();
    expect(parseManualStepRequests(Array.from({ length: 6 }, (_, i) => ({ ...base, key: `key-${i}-abc` }))).error).toBeTruthy();
    expect(parseManualStepRequests([{ ...base, key: "A" }]).error).toBeTruthy();
  });
  it("タイトルの接頭辞とkeyの重複を拒否する", () => {
    expect(parseManualStepRequests([{ ...base, title: "検証DB" }]).error).toBeTruthy();
    expect(parseManualStepRequests([base, base]).error).toContain("重複");
  });
  it("秘密値らしき文字列を拒否する", () => {
    expect(parseManualStepRequests([{ ...base, body: `${validBody}\nAPI_TOKEN=abcdefghijklmnopqrstuvwxyz123456` }]).error).toBeTruthy();
  });
  it("書式が不足する本文を拒否する", () => {
    expect(parseManualStepRequests([{ ...base, body: "やってください" }]).error).toBeTruthy();
  });
});

describe("marker / comment", () => {
  const origin = { repository: "guchi-apps/asset-manager", issueNumber: 698, pullRequest: 699 };
  it("起点Issueとkeyを含む安定したマーカーを作る", () => {
    expect(manualStepKeyMarker(origin, "k-abc")).toBe("<!-- issue-deck-manual-step-key:guchi-apps/asset-manager#698:k-abc -->");
  });
  it("コメントに起票先へのリンクと再利用の別を載せる", () => {
    const text = renderFilingComment(origin, [{ key: "k-abc", repository: "guchi-apps/vps", number: 5, url: "https://x/5", outcome: "reused", warnings: [] }]);
    expect(text).toContain("guchi-apps/vps#5（既存を再利用）");
  });
});
