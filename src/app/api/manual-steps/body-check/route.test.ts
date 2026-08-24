import { beforeEach, describe, expect, it, vi } from "vitest";

import { MANUAL_STEP_BODY_CHECK_MARKER } from "@/lib/manual-step-body-check";

const { POST } = await import("./route");

function checkRequest(body: unknown, token: string | null = "test-secret") {
  return new Request("http://localhost/api/manual-steps/body-check", {
    method: "POST",
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

/** 指摘が1件も出ない最小の本文 */
const CLEAN_BODY = [
  "## この作業でできるようになること",
  "",
  "- できるようになること: 通知が届く",
  "- 実行するまでできないこと: 届かない",
  "- 急ぎ具合: 急がない",
  "",
  "## 前提条件",
  "",
  "- 実行するデバイス: サブPC（メインPCからなら `ssh subpc`）",
  "- カレントディレクトリ: `~/apps/issue-deck`",
  "- Gitブランチ: `develop`",
  "- 先に完了している必要があるIssue・PR: なし",
  "- その他の前提: なし",
  "",
  "## やること",
  "",
  "- [ ] 実行する",
  "",
  "  ```bash",
  "  echo ok",
  "  ```",
  "",
  "## 完了の確認方法",
  "",
  "- 実行できている",
  "",
  "  ```bash",
  "  echo ok",
  "  ```",
  "",
  "## なぜエージェントが実施しないか",
  "",
  "権限が無いため。",
  "",
  "## 関連",
  "",
  "- 起点Issue: #1",
].join("\n");

beforeEach(() => {
  vi.stubEnv("PROGRESS_REPORT_SECRET", "test-secret");
});

describe("POST /api/manual-steps/body-check", () => {
  it("指摘が無ければ findings は空で comment は null", async () => {
    const res = await POST(checkRequest({ repository: "guchi-apps/issue-deck", body: CLEAN_BODY }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ findings: [], comment: null });
  });

  it("指摘があればマーカー付きのコメント本文まで組み立てて返す", async () => {
    const body = CLEAN_BODY.replace(
      "- 起点Issue: #1",
      "- 対応PR: https://github.com/guchi-apps/aide/pull/102",
    );
    const res = await POST(checkRequest({ repository: "guchi-apps/issue-deck", body }));

    const json = (await res.json()) as { findings: { rule: string }[]; comment: string };
    expect(json.findings.map((finding) => finding.rule)).toContain("reference-not-hash-form");
    expect(json.comment.startsWith(MANUAL_STEP_BODY_CHECK_MARKER)).toBe(true);
    // 別リポジトリの参照なので owner/repo#番号 を提案する
    expect(json.comment).toContain("guchi-apps/aide#102");
  });

  it("シークレットが違えば401、未設定なら503（呼び出し側が設定漏れと切り分けられるようにする）", async () => {
    expect((await POST(checkRequest({ body: CLEAN_BODY }, "wrong"))).status).toBe(401);
    expect((await POST(checkRequest({ body: CLEAN_BODY }, null))).status).toBe(401);

    vi.stubEnv("PROGRESS_REPORT_SECRET", "");
    expect((await POST(checkRequest({ body: CLEAN_BODY }))).status).toBe(503);
  });

  it("bodyが文字列でなければ400", async () => {
    expect((await POST(checkRequest({ repository: "a/b" }))).status).toBe(400);
    expect((await POST(checkRequest({ body: 123 }))).status).toBe(400);
  });

  it("長すぎる本文は受けない", async () => {
    expect((await POST(checkRequest({ body: "a".repeat(100_001) }))).status).toBe(413);
  });

  // 本文はGitHubから引き直さない。リポジトリ名が無くても検査そのものは通る
  it("リポジトリ名が無くても検査できる", async () => {
    const res = await POST(checkRequest({ body: CLEAN_BODY }));
    expect(res.status).toBe(200);
  });
});
