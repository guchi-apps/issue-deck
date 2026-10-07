import { describe, expect, it } from "vitest";

import { extractRefs, parseIntent, resolveIntent } from "@/lib/chat/intent";
import { EMPTY_CHAT_CONTEXT, type ChatContext } from "@/lib/chat/types";

const REPO = "guchi-apps/issue-deck";
const target = (number: number) => ({ repo: REPO, number, kind: "pr" as const, title: `PR ${number}` });
const ctx = (numbers: number[]): ChatContext => ({
  repo: REPO,
  targets: numbers.map(target),
  actions: [],
});

describe("extractRefs", () => {
  it("#付き・裸の番号・複数・repo指定を拾う", () => {
    expect(extractRefs("3966どうなってる？")).toEqual([{ repo: null, number: 3966 }]);
    expect(extractRefs("#3966と#3963")).toEqual([
      { repo: null, number: 3966 },
      { repo: null, number: 3963 },
    ]);
    expect(extractRefs("3960と3961どうなってる？").map((r) => r.number)).toEqual([3960, 3961]);
    expect(extractRefs("guchi-apps/vps#12")).toEqual([{ repo: "guchi-apps/vps", number: 12 }]);
  });

  it("1桁の裸の数字は番号として扱わない", () => {
    expect(extractRefs("3つ確認して")).toEqual([]);
  });
});

describe("parseIntent", () => {
  it("状況確認", () => {
    expect(parseIntent("3966どうなってる？")).toEqual({ type: "status", refs: [{ repo: null, number: 3966 }] });
    expect(parseIntent("もう一回確認して")).toEqual({ type: "recheck" });
    expect(parseIntent("PRは？")).toEqual({ type: "recheck" });
  });

  it("修復・マージ可否・Issue起案", () => {
    expect(parseIntent("自動修正して")).toEqual({ type: "repair", ref: null });
    expect(parseIntent("#3966を自動修正して")).toEqual({ type: "repair", ref: { repo: null, number: 3966 } });
    expect(parseIntent("マージできる？")).toEqual({ type: "merge_check" });
    expect(parseIntent("この問題は別Issueにして")).toEqual({ type: "create_issue", title: null });
  });

  it("読み取れない文章はunknown", () => {
    expect(parseIntent("こんにちは")).toEqual({ type: "unknown" });
    expect(parseIntent("   ")).toEqual({ type: "unknown" });
  });
});

describe("resolveIntent", () => {
  it("直前の対象が1件なら「直して」はそのPRを指す", () => {
    expect(resolveIntent({ type: "repair", ref: null }, ctx([3966]))).toEqual({
      type: "repair",
      target: { repo: REPO, number: 3966 },
    });
  });

  it("直前に複数を見せた後の「直して」は聞き返す（実行しない）", () => {
    const resolved = resolveIntent({ type: "repair", ref: null }, ctx([3960, 3961]));
    expect(resolved.type).toBe("ask");
    if (resolved.type === "ask") {
      expect(resolved.options.map((o) => o.send)).toEqual([
        `${REPO}#3960を直して`,
        `${REPO}#3961を直して`,
      ]);
    }
  });

  it("対象が無いときの「直して」は聞き返す", () => {
    expect(resolveIntent({ type: "repair", ref: null }, EMPTY_CHAT_CONTEXT).type).toBe("ask");
  });

  it("番号を明示した「直して」は文脈より優先する", () => {
    expect(resolveIntent({ type: "repair", ref: { repo: null, number: 12 } }, ctx([3960, 3961]))).toEqual({
      type: "repair",
      target: { repo: REPO, number: 12 },
    });
  });

  it("repoが決まらない番号は聞き返す", () => {
    expect(resolveIntent({ type: "status", refs: [{ repo: null, number: 1 }] }, EMPTY_CHAT_CONTEXT).type).toBe("ask");
  });

  it("別Issueにしては直前の対象のrepoを使う", () => {
    expect(resolveIntent({ type: "create_issue", title: null }, ctx([3966]))).toMatchObject({
      type: "create_issue",
      repo: REPO,
      source: { number: 3966 },
    });
  });
});

describe("調査の意図（#4045）", () => {
  it("理由・内容・方針の質問は定型の状態確認ではなく調査へ回す", () => {
    expect(parseIntent("#3966はなぜ止まっている？")).toEqual({ type: "investigate", ref: { repo: null, number: 3966 } });
    expect(parseIntent("レビューの内容を教えて")).toEqual({ type: "investigate", ref: null });
    expect(parseIntent("この方針で続けて")).toEqual({ type: "investigate", ref: null });
  });
  it("「確認して直して」は定型の自動修正ではなく調査を通す。素の「直して」は従来どおり", () => {
    expect(parseIntent("確認して直して")).toEqual({ type: "investigate", ref: null, fix: true });
    expect(parseIntent("#12を確認して直して")).toEqual({ type: "investigate", ref: { repo: null, number: 12 }, fix: true });
  });
  it("「直して」「修正して」だけでも調査を起点にする（#4153）。自動修正の起動は明示の言い回しだけ", () => {
    expect(parseIntent("直して")).toEqual({ type: "investigate", ref: null, fix: true });
    expect(parseIntent("#4142を修正して")).toEqual({ type: "investigate", ref: { repo: null, number: 4142 }, fix: true });
    expect(parseIntent("修正してください")).toEqual({ type: "investigate", ref: null, fix: true });
    expect(parseIntent("自動修正を再実行して")).toEqual({ type: "repair", ref: null });
    expect(resolveIntent({ type: "investigate", ref: null, fix: true }, ctx([3966]))).toMatchObject({
      type: "investigate",
      target: { number: 3966 },
      fix: true,
    });
  });
  it("対象は明示 → 直前の1件 → 調査の引き継ぎの順で決め、複数で決まらないときは候補を調査へ渡す", () => {
    expect(resolveIntent({ type: "investigate", ref: { repo: null, number: 9 } }, ctx([1, 2]))).toEqual({
      type: "investigate",
      target: { repo: REPO, number: 9 },
      candidates: [],
    });
    expect(resolveIntent({ type: "investigate", ref: null }, ctx([5]))).toMatchObject({ target: { number: 5 } });
    const withInvestigation: ChatContext = {
      ...ctx([]),
      investigation: {
        target: target(7),
        summary: "s",
        evidence: [],
        agreements: [],
        openQuestions: [],
        unconfirmed: [],
        updatedAt: "",
      },
    };
    expect(resolveIntent({ type: "investigate", ref: null }, withInvestigation)).toMatchObject({ target: { number: 7 } });
    const multi = resolveIntent({ type: "investigate", ref: null }, ctx([1, 2]));
    expect(multi).toMatchObject({ type: "investigate", target: null });
    expect(multi.type === "investigate" && multi.candidates).toHaveLength(2);
  });
});

describe("番号のない設計相談（#4093）", () => {
  const CONSULT = "勤務画面では、月表示だと表示数が多くて月末のときに見にくい。週ごとに表示されるぐらいの方が見やすいかも";
  const consulting: ChatContext = {
    repo: REPO,
    targets: [],
    actions: [],
    investigation: { target: null, summary: "s", evidence: [], agreements: [], openQuestions: [], unconfirmed: [], updatedAt: "" },
  };

  it("初回の相談文は操作ではなくunknown（調査へ渡る）", () => {
    expect(parseIntent(CONSULT)).toEqual({ type: "unknown" });
  });

  it("「31日」「30件」などの単位付きの数値を番号とみなさない", () => {
    expect(extractRefs("月末の31日が見にくい")).toEqual([]);
    expect(extractRefs("30件を超えると重い")).toEqual([]);
    expect(parseIntent("月末の31日が見にくい")).toEqual({ type: "unknown" });
    expect(extractRefs("3966どうなってる？")).toEqual([{ repo: null, number: 3966 }]);
  });

  it("相談中の質問・前置きを修正依頼・Issue起案と区別する", () => {
    expect(parseIntent("直すならどの案がよい？")).toEqual({ type: "investigate", ref: null });
    expect(parseIntent("Issueにする前に相談したい")).toEqual({ type: "investigate", ref: null });
    expect(parseIntent("この内容でIssue起案して").type).toBe("create_issue");
  });

  it("相談の途中の「現状を確認して」は前のPRではなく相談へつなぐ", () => {
    const withPr: ChatContext = { ...consulting, targets: [] };
    expect(resolveIntent(parseIntent("現状を確認して"), withPr)).toEqual({ type: "investigate", target: null, candidates: [] });
    expect(resolveIntent(parseIntent("確認して"), ctx([]))).toMatchObject({ type: "ask" });
  });
});
