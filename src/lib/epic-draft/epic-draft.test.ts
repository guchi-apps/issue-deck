import { describe, expect, it, vi } from "vitest";

import { createEpic, type EpicGithub, type EpicGithubIssue, type EpicPlanRegistrar } from "@/lib/epic-draft/create";
import { computeEpicStages, parseEpicDraft, validateEpicDraft } from "@/lib/epic-draft/decompose";
import { epicDoneText, epicFailureText } from "@/lib/epic-draft/report";
import type { EpicDraft } from "@/lib/epic-draft/types";

const draft: EpicDraft = {
  parent: { repo: "o/a", title: "親", objective: "目的", completionCriteria: ["本番反映"], scope: "範囲" },
  children: [
    { key: "c1", repo: "o/a", title: "共通仕様", body: "要件1", dependsOn: [] },
    { key: "c2", repo: "o/a", title: "実行", body: "要件2", dependsOn: [{ key: "c1", conditions: ["merged"] }] },
    { key: "c3", repo: "o/b", title: "画面", body: "要件3", existing: 7, dependsOn: [{ key: "c1", conditions: ["merged"] }] },
    { key: "c4", repo: "o/b", title: "配布", body: "要件4", dependsOn: [{ key: "c2", conditions: ["verified"] }, { key: "c3", conditions: ["verified"] }] },
  ],
};

/** GitHubのメモリ実装。`failOn`で任意の操作を1回だけ失敗させる */
function fakeGithub(seed: Record<string, EpicGithubIssue[]> = {}) {
  const repos = new Map<string, EpicGithubIssue[]>(Object.entries(seed));
  const links: string[] = [];
  let nextId = 1000;
  const fail = { op: "" as string };
  const maybe = (op: string) => {
    if (fail.op === op) {
      fail.op = "";
      throw new Error(`${op}失敗`);
    }
  };
  const github: EpicGithub = {
    async listIssues(repo) {
      maybe(`list:${repo}`);
      return (repos.get(repo) ?? []).map((i) => ({ ...i }));
    },
    async createIssue(repo, input) {
      maybe("create");
      const list = repos.get(repo) ?? [];
      const number = 100 + list.length + 1;
      const id = nextId++;
      list.push({ number, id, state: "open", body: input.body });
      repos.set(repo, list);
      return { number, id };
    },
    async updateBody(repo, number, body) {
      maybe("body");
      const i = repos.get(repo)!.find((x) => x.number === number)!;
      i.body = body;
    },
    async listSubIssues() {
      return links.map((l) => ({ repo: l.split("#")[0], number: Number(l.split("#")[1]) }));
    },
    async addSubIssue(_parent, childId) {
      maybe("link");
      const found = [...repos.entries()].flatMap(([repo, is]) => is.map((i) => ({ repo, i }))).find((x) => x.i.id === childId)!;
      links.push(`${found.repo}#${found.i.number}`);
    },
  };
  return { github, repos, links, fail };
}

const okPlan: EpicPlanRegistrar = async () => ({ ok: true, version: 1 });
const params = { requestKey: "req1", draft };
const seed = () => ({ "o/b": [{ number: 7, id: 7, state: "closed" as const, body: "既存" }] });

describe("parseEpicDraft / validateEpicDraft", () => {
  const allow = () => true;
  it("段を並行範囲ごとに計算する", () => {
    expect(computeEpicStages(draft.children)).toEqual([["c1"], ["c2", "c3"], ["c4"]]);
  });
  it("正常な案は検証を通る", () => {
    expect(validateEpicDraft(draft, allow)).toEqual([]);
    expect(parseEpicDraft(JSON.stringify(draft))?.children).toHaveLength(4);
  });
  it("循環・存在しない依存・自己依存・権限外・上限超過・子の不足を拒否する", () => {
    const cyc = structuredClone(draft);
    cyc.children[0].dependsOn = [{ key: "c4", conditions: ["merged"] }];
    expect(validateEpicDraft(cyc, allow)).toContain("依存関係が循環しています");
    const missing = structuredClone(draft);
    missing.children[1].dependsOn = [{ key: "zz", conditions: ["merged"] }];
    expect(validateEpicDraft(missing, allow).join()).toContain("存在しない依存先 zz");
    const self = structuredClone(draft);
    self.children[1].dependsOn = [{ key: "c2", conditions: ["merged"] }];
    expect(validateEpicDraft(self, allow).join()).toContain("自分自身");
    expect(validateEpicDraft(draft, (r) => r !== "o/b").join()).toContain("権限内のリポジトリではありません");
    const many = structuredClone(draft);
    many.children.push(
      { key: "c5", repo: "o/a", title: "t", body: "b", dependsOn: [] },
      { key: "c6", repo: "o/a", title: "t", body: "b", dependsOn: [] },
    );
    expect(validateEpicDraft(many, allow).join()).toContain("5件を超えて");
    const few = structuredClone(draft);
    few.children = few.children.slice(0, 1);
    expect(validateEpicDraft(few, allow).join()).toContain("2件未満");
  });
  it("壊れたJSONはnull", () => {
    expect(parseEpicDraft("{")).toBeNull();
    expect(parseEpicDraft("{}")).toBeNull();
  });
});

describe("createEpic", () => {
  it("正常系: 親・子・紐付け・計画・本文を作り、既存Issueは再利用する", async () => {
    const { github, repos, links } = fakeGithub(seed());
    const register = vi.fn(okPlan);
    const out = await createEpic(params, github, register);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.progress.children.c3).toMatchObject({ repo: "o/b", number: 7, reused: true });
    expect(links).toHaveLength(4);
    // 既存の本文は書き換えない
    expect(repos.get("o/b")!.find((i) => i.number === 7)!.body).toBe("既存");
    // 新規は親(1)＋子3件（c1,c2,c4）
    expect(repos.get("o/a")).toHaveLength(3);
    expect(repos.get("o/b")).toHaveLength(2);
    const planArg = register.mock.calls[0][0];
    expect(planArg.children.find((c) => c.number === 7)).toBeDefined();
    expect(planArg.children.at(-1)!.dependsOn.map((d) => d.repo)).toEqual(["o/a", "o/b"]);
    const parentBody = repos.get("o/a")![0].body!;
    expect(parentBody).toContain("子Issueと実行順序");
    expect(parentBody).toContain("o/b#7");
    expect(epicDoneText(draft, out)).toContain("実装を開始しません");
  });

  it("2回呼んでも親子を増やさない（再送・並行の再実行）", async () => {
    const { github, repos } = fakeGithub(seed());
    await createEpic(params, github, okPlan);
    const total = () => [...repos.values()].flat().length;
    const before = total();
    const again = await createEpic(params, github, okPlan);
    expect(again.ok).toBe(true);
    expect(total()).toBe(before);
  });

  it("親だけ作成済みで止まっても、再開で残りだけ作る", async () => {
    const { github, repos, fail } = fakeGithub(seed());
    fail.op = "create";
    // 親の作成は成功させ、最初の子で失敗させるため、1回目は通す
    let n = 0;
    const orig = github.createIssue;
    github.createIssue = async (repo, input) => {
      n += 1;
      if (n === 2) throw new Error("子の作成失敗");
      return orig(repo, input);
    };
    fail.op = "";
    const first = await createEpic(params, github, okPlan);
    expect(first).toMatchObject({ ok: false, stage: "children" });
    expect(first.progress.parent).not.toBeNull();
    expect(epicFailureText(first as never)).toContain("完了していません");
    github.createIssue = orig;
    const second = await createEpic(params, github, okPlan);
    expect(second.ok).toBe(true);
    expect(repos.get("o/a")!.filter((i) => i.body?.includes("epic-unit: req1/parent"))).toHaveLength(1);
    expect([...repos.values()].flat().filter((i) => i.body?.includes("epic-unit: req1/c1"))).toHaveLength(1);
  });

  it("紐付けに失敗したら完了とせず、再開で紐付けだけやり直す", async () => {
    const { github, repos, links, fail } = fakeGithub(seed());
    fail.op = "link";
    const first = await createEpic(params, github, okPlan);
    expect(first).toMatchObject({ ok: false, stage: "link" });
    const created = [...repos.values()].flat().length;
    const second = await createEpic(params, github, okPlan);
    expect(second.ok).toBe(true);
    expect([...repos.values()].flat().length).toBe(created);
    expect(links).toHaveLength(4);
  });

  it("計画登録に失敗したら完了とせず、再開で計画だけ登録する", async () => {
    const { github, repos } = fakeGithub(seed());
    const bad: EpicPlanRegistrar = async () => ({ ok: false, message: "計画の検証に失敗" });
    const first = await createEpic(params, github, bad);
    expect(first).toMatchObject({ ok: false, stage: "plan" });
    const created = [...repos.values()].flat().length;
    const second = await createEpic(params, github, okPlan);
    expect(second.ok).toBe(true);
    expect([...repos.values()].flat().length).toBe(created);
  });

  it("GitHubの取得に失敗したら未作成とみなさず、何も作らない", async () => {
    const { github, repos, fail } = fakeGithub(seed());
    fail.op = "list:o/b";
    const out = await createEpic(params, github, okPlan);
    expect(out).toMatchObject({ ok: false, stage: "reconcile" });
    expect(repos.get("o/a") ?? []).toHaveLength(0);
  });

  it("再利用する既存Issueが見つからなければ止まる（誤参照しない）", async () => {
    const { github } = fakeGithub({ "o/b": [] });
    const out = await createEpic(params, github, okPlan);
    expect(out).toMatchObject({ ok: false, stage: "children" });
  });
});
