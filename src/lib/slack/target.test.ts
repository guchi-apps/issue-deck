import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { issue: { findMany: vi.fn().mockResolvedValue([{ title: "車検の期限を出す", repository: { fullName: "guchi-apps/car-care" } }]) } } }));

vi.mock("@/lib/chat/investigation/model", () => ({ resolveChatExecution: vi.fn().mockResolvedValue({ mode: "api" }) }));

import { extractExplicitRepos, resolveTarget, type TargetModel } from "@/lib/slack/target";

const candidates = [
  { fullName: "guchi-apps/car-care", name: "car-care" },
  { fullName: "guchi-apps/issue-deck", name: "issue-deck" },
  { fullName: "guchi-apps/asset-manager", name: "asset-manager" },
];
const model = (value: object): TargetModel => async () => ({ ok: true, text: JSON.stringify(value) });
const never: TargetModel = async () => {
  throw new Error("AIを呼ばない場面");
};

describe("対象リポジトリの判別（#4527）", () => {
  it("owner/repoの明示を最優先し、AIを呼ばない", async () => {
    expect(await resolveTarget("guchi-apps/issue-deck の画面を直したい", candidates, { callModel: never })).toMatchObject({ kind: "resolved", repo: "guchi-apps/issue-deck" });
  });

  it("候補にないowner/repo（同じ組織の未接続・権限外）はdeniedで、作成先にしない", async () => {
    expect(await resolveTarget("guchi-apps/secret に足したい", candidates, { callModel: never })).toMatchObject({ kind: "denied", repo: "guchi-apps/secret" });
    expect(extractExplicitRepos("and/or の話", candidates)).toEqual({ found: [], denied: [] });
  });

  it("リポジトリ名が一意に書かれていれば名称一致で決める", async () => {
    expect(await resolveTarget("car-careの通知を直す", candidates, { callModel: never })).toMatchObject({ kind: "resolved", repo: "guchi-apps/car-care" });
  });

  it("名称を含まない依頼は、AIが高確信で候補から選べば採用する", async () => {
    const decision = await resolveTarget("車検の期限が分かりにくい", candidates, { callModel: model({ repo: "guchi-apps/car-care", confidence: "high", candidates: [], reason: "車の整備" }) });
    expect(decision).toMatchObject({ kind: "resolved", repo: "guchi-apps/car-care" });
    expect(decision.basis).toContain("車の整備");
  });

  it("AIの確信が低い・複数候補なら、絞った候補付きで対象確認にする", async () => {
    const decision = await resolveTarget("通知がおかしい", candidates, { callModel: model({ repo: "", confidence: "low", candidates: ["guchi-apps/car-care", "guchi-apps/issue-deck", "other/x"], reason: "どちらもあり得る" }) });
    expect(decision).toMatchObject({ kind: "ambiguous" });
    expect(decision.kind === "ambiguous" && decision.options.map((c) => c.fullName)).toEqual(["guchi-apps/car-care", "guchi-apps/issue-deck"]);
  });

  it("確信が高くても候補外の答えは採用しない。AI障害・不正な応答は対象確認に回す（作成しない）", async () => {
    expect((await resolveTarget("x", candidates, { callModel: model({ repo: "evil/x", confidence: "high", candidates: [], reason: "" }) })).kind).toBe("ambiguous");
    expect((await resolveTarget("x", candidates, { callModel: async () => ({ ok: false, reason: "HTTP 429" }) })).kind).toBe("ambiguous");
    expect((await resolveTarget("x", candidates, { callModel: async () => ({ ok: true, text: "not json" }) })).kind).toBe("ambiguous");
  });

  it("AI判別が失敗しても、語の一致で関連候補に絞る。一意に強く一致すれば確認なしで決める", async () => {
    const decision = await resolveTarget("車検の期限が分かりにくい", candidates, { callModel: async () => ({ ok: false, reason: "HTTP 401" }) });
    expect(decision).toMatchObject({ kind: "resolved", repo: "guchi-apps/car-care" });
  });

  it("手がかりが無いAI失敗では、先頭の候補を並べず空の候補と失敗理由を返す", async () => {
    const decision = await resolveTarget("改善したい", candidates, { callModel: async () => ({ ok: false, reason: "HTTP 429" }) });
    expect(decision).toMatchObject({ kind: "ambiguous", options: [], aiFailure: "HTTP 429" });
  });

  it("Codex設定でAI判別をスキップしたときは失敗扱いにせず、語の一致で絞る", async () => {
    const decision = await resolveTarget("改善したい", candidates, { callModel: async () => ({ ok: false, reason: "Codexのため", skipped: true }) });
    expect(decision).toMatchObject({ kind: "ambiguous", options: [] });
    expect((decision as { aiFailure?: string }).aiFailure).toBeUndefined();
  });
});
