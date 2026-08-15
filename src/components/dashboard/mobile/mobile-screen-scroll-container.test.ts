import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// スマホの各画面が持つ縦スクロール領域には`flex-1`を付ける、という規約を固定する（#1664）。
//
// 付け忘れても見た目の高さは変わらない（`flex: 0 1 auto`でも縮小して収まる）ため、
// レビューでもローカルのブラウザでも気づけない。実害はiOSのホーム画面アプリ
// （standalone PWA）でだけ出る。中身の高さが変わるたびにスクロール領域の箱が
// 再レイアウトされ、レイアウトは正しいのに背景も文字も描かれない領域が残る。
// Issue詳細だけがこの付け忘れの状態で、実際に描画が抜ける不具合になっていた。
//
// レンダリングして`getComputedStyle`で見る形にはしない。この画面群はGitHub APIを叩く
// フックを多数持ち、描画させるだけでモックの束が要る。`dev-server-bind.test.ts`と同じく
// 内容の検査に留める。
const MOBILE_DIR = join(process.cwd(), "src/components/dashboard/mobile");

/**
 * 高さの上限を自前で持つスクロール領域（`SheetContent`の`max-h-[80vh]`や、
 * 一覧の中に埋め込んだ`max-h-48`の小さな枠）は対象外。これらは親の残りを
 * 埋める領域ではないため`flex-1`を付けない。
 */
function isBoundedScroller(line: string): boolean {
  return /max-h-/.test(line);
}

describe("スマホ画面の縦スクロール領域（#1664）", () => {
  const files = readdirSync(MOBILE_DIR).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test."),
  );

  it("検査対象のファイルが見つかる", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s のスクロール領域には flex-1 が付いている", (name) => {
    const lines = readFileSync(join(MOBILE_DIR, name), "utf8").split("\n");
    const offenders = lines.filter(
      (line) =>
        line.includes("overflow-y-auto") && !isBoundedScroller(line) && !/\bflex-1\b/.test(line),
    );

    expect(offenders).toEqual([]);
  });
});
