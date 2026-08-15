import { describe, expect, it } from "vitest";

import {
  rehypeTaskListItems,
  TASK_ITEM_ATTRIBUTE,
  TASK_LINE_ATTRIBUTE,
} from "@/lib/rehype-task-list-items";

type Node = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { line: number } };
  value?: string;
};

function checkbox(): Node {
  return { type: "element", tagName: "input", properties: { type: "checkbox" }, children: [] };
}

function listItem(line: number, children: Node[]): Node {
  return {
    type: "element",
    tagName: "li",
    properties: {},
    children,
    position: { start: { line } },
  };
}

function list(children: Node[]): Node {
  return { type: "element", tagName: "ul", properties: {}, children };
}

function run(tree: Node) {
  rehypeTaskListItems()(tree as never);
  return tree;
}

describe("rehypeTaskListItems", () => {
  it("チェックボックスにliの行番号を付ける", () => {
    const box = checkbox();
    const tree = run({ type: "root", children: [list([listItem(3, [box, { type: "text", value: " やる" }])])] });

    expect(box.properties?.[TASK_LINE_ATTRIBUTE]).toBe(3);
    const item = (tree.children?.[0].children ?? [])[0];
    expect(item.properties?.[TASK_ITEM_ATTRIBUTE]).toBe(true);
  });

  it("looseなリスト（liの下にp）でも行番号を付ける", () => {
    const box = checkbox();
    const item = listItem(7, [{ type: "element", tagName: "p", properties: {}, children: [box] }]);
    run({ type: "root", children: [list([item])] });

    expect(box.properties?.[TASK_LINE_ATTRIBUTE]).toBe(7);
  });

  // 入れ子のタスクでは、親のliが子のチェックボックスを掴んで行番号を上書きしてはいけない
  it("入れ子のリストへは降りず、それぞれのliの行番号を付ける", () => {
    const parentBox = checkbox();
    const childBox = checkbox();
    const child = listItem(2, [childBox]);
    const parent = listItem(1, [parentBox, list([child])]);
    run({ type: "root", children: [list([parent])] });

    expect(parentBox.properties?.[TASK_LINE_ATTRIBUTE]).toBe(1);
    expect(childBox.properties?.[TASK_LINE_ATTRIBUTE]).toBe(2);
  });

  it("チェックボックスの無いliには何も付けない", () => {
    const item = listItem(1, [{ type: "text", value: "ふつうの箇条書き" }]);
    run({ type: "root", children: [list([item])] });

    expect(item.properties?.[TASK_ITEM_ATTRIBUTE]).toBeUndefined();
  });

  // 親がチェックボックスを持たない場合、子のチェックボックスを親のものとして扱わない
  it("チェックボックスの無い親liは、子のチェックボックスを自分のものにしない", () => {
    const childBox = checkbox();
    const parent = listItem(1, [
      { type: "text", value: "ふつうの箇条書き" },
      list([listItem(2, [childBox])]),
    ]);
    run({ type: "root", children: [list([parent])] });

    expect(parent.properties?.[TASK_ITEM_ATTRIBUTE]).toBeUndefined();
    expect(childBox.properties?.[TASK_LINE_ATTRIBUTE]).toBe(2);
  });

  it("行番号を持たないliは対象外（トグル先を特定できないため）", () => {
    const box = checkbox();
    const item: Node = { type: "element", tagName: "li", properties: {}, children: [box] };
    run({ type: "root", children: [list([item])] });

    expect(box.properties?.[TASK_LINE_ATTRIBUTE]).toBeUndefined();
    expect(item.properties?.[TASK_ITEM_ATTRIBUTE]).toBeUndefined();
  });

  it("チェックボックス以外のinputには付けない", () => {
    const text: Node = {
      type: "element",
      tagName: "input",
      properties: { type: "text" },
      children: [],
    };
    run({ type: "root", children: [list([listItem(1, [text])])] });

    expect(text.properties?.[TASK_LINE_ATTRIBUTE]).toBeUndefined();
  });
});
