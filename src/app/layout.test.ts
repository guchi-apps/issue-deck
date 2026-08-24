import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * アプリシェルの高さの決め方を守る（#2263）。
 *
 * bodyは`fixed inset-0`でビューポートへ固定してある（#607。iOS Safariのラバーバンド対策）が、
 * **高さをそれだけに頼らない**。Radixのダイアログ・セレクトを開いている間、react-remove-scrollが
 * `body[data-scroll-locked] { position: relative !important }`をbodyへ当てるため、`fixed`が外れた
 * 時点でbodyの高さがauto（中身の高さ）になり、`h-full`→`flex-1`＋`min-h-0`で組んだ画面の高さの
 * 連鎖が全部ほどける。Issue一覧などのスクロール領域が中身の高さまで伸びてスクロール不能になり、
 * その瞬間にブラウザがscrollTopを0へ落とすので、モーダルを閉じたあと一覧が先頭に戻ってしまう。
 *
 * `h-full`は`fixed inset-0`と重複して見えるため「要らない指定」として消されやすい。実際の症状は
 * モーダルを開閉したときにしか出ず、jsdomはレイアウトを持たないので描画のテストでも捕まらない。
 * ここではクラスが並んでいることだけを見張る。
 */
const LAYOUT_SOURCE = "src/app/layout.tsx";

function bodyClassName(): string {
  const source = readFileSync(LAYOUT_SOURCE, "utf8");
  const matched = /<body className="([^"]*)"/.exec(source);
  if (!matched) throw new Error(`${LAYOUT_SOURCE} の<body>のclassNameを読めませんでした`);
  return matched[1];
}

describe("アプリシェルのbodyのクラス（#2263）", () => {
  it("高さをpositionに依存させないためのh-fullを持つ", () => {
    expect(bodyClassName().split(/\s+/)).toContain("h-full");
  });

  it("ビューポートへの固定（#607）も残っている", () => {
    const classes = bodyClassName().split(/\s+/);
    expect(classes).toContain("fixed");
    expect(classes).toContain("inset-0");
    expect(classes).toContain("overscroll-none");
  });
});
