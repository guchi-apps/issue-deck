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
    expect(parseIntent("直して")).toEqual({ type: "repair", ref: null });
    expect(parseIntent("#3966を直して")).toEqual({ type: "repair", ref: { repo: null, number: 3966 } });
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
