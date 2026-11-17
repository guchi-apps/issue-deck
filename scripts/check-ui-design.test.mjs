// 不適切なデザインの静的検出（scripts/check-ui-design.mjs）の振る舞いを固定する（#5465）。

import { describe, expect, it } from "vitest";

import { scanText } from "./check-ui-design.mjs";

const rules = (text) => scanText(text).filter((f) => !f.excluded).map((f) => f.rule);

describe("check-ui-design", () => {
  it("左端の色付きボーダーを検出する", () => {
    expect(rules('<div className="border-l-4 border-blue-500 p-2">')).toEqual(["side-border"]);
    expect(rules('<div className="border-l-2 border-destructive/40">')).toEqual(["side-border"]);
  });

  it("色の無い左ボーダーや通常の枠は検出しない", () => {
    expect(rules('<div className="border-l pl-2">')).toEqual([]);
    expect(rules('<div className="border border-border">')).toEqual([]);
  });

  it("グラデーションを検出し、繰り返しパターンは見ない", () => {
    expect(rules('<div className="bg-gradient-to-r from-blue-500">')).toEqual(["gradient"]);
    expect(rules("background: linear-gradient(red, blue)")).toEqual(["gradient"]);
    expect(rules('"bg-[repeating-linear-gradient(90deg,red_0_3px,transparent_3px_6px)]"')).toEqual([]);
  });

  it("絵文字を検出し、✓や×のようなテキスト記号とコメント行は見ない", () => {
    expect(rules("<button>🚀 開始</button>")).toEqual(["emoji-icon"]);
    expect(rules('{ok ? "✅" : "❌"}')).toEqual(["emoji-icon"]);
    expect(rules('{ok ? "✓" : "×"}')).toEqual([]);
    expect(rules("// 🚀 ここはコメント")).toEqual([]);
  });

  it("絵文字の対象は画面を描くコードだけで、.ts の文面・マーカーは見ない", () => {
    const active = (text, file) => scanText(text, file).filter((f) => !f.excluded).map((f) => f.rule);
    expect(active("<span>✅ 記録済み</span>", "src/components/a.tsx")).toEqual(["emoji-icon"]);
    expect(active('lines.push("⚠️ **終了しました**");', "src/lib/dispatch/session-wrapup.ts")).toEqual([]);
    expect(active('["🔍", "planner"],', "src/lib/github/comment-source.ts")).toEqual([]);
    // 絵文字以外のルールは .ts でも見る
    expect(active('"shadow-lg"', "src/lib/x.ts")).toEqual(["heavy-shadow"]);
  });

  it("大きな影を検出する", () => {
    expect(rules('<div className="shadow-lg">')).toEqual(["heavy-shadow"]);
    expect(rules('<div className="shadow-sm">')).toEqual([]);
  });

  it("design-ok: <理由> を同じ行・直前の行に書くと除外される", () => {
    const same = scanText('<div className="border-l-4 border-red-500"> {/* design-ok: 引用ブロックの左線 */}');
    expect(same[0].excluded).toBe(true);
    expect(same[0].reason).toBe("引用ブロックの左線");
    const prev = scanText('// design-ok: 選択中の現在地\n<div className="border-l-2 border-primary">');
    expect(prev[0].excluded).toBe(true);
  });

  it("理由の無い design-ok では除外されない", () => {
    expect(scanText('<div className="border-l-4 border-red-500"> // design-ok:')[0].excluded).toBe(false);
  });
});
