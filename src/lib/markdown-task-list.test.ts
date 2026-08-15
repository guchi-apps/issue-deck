import { describe, expect, it } from "vitest";

import { countTaskListItems, toggleTaskListLine } from "@/lib/markdown-task-list";

describe("countTaskListItems", () => {
  it("チェック済みと未チェックを数える", () => {
    const body = ["## やること", "", "- [x] VPSへSSHする", "- [ ] .envを書き換える", "- [X] 再起動する"].join(
      "\n",
    );

    expect(countTaskListItems(body)).toEqual({ total: 3, completed: 2 });
  });

  it("リストマーカーが * + や番号付きでも数える", () => {
    const body = ["* [ ] ひとつ目", "+ [x] ふたつ目", "1. [ ] みっつ目", "2) [x] よっつ目"].join("\n");

    expect(countTaskListItems(body)).toEqual({ total: 4, completed: 2 });
  });

  it("ネストしたタスクも数える", () => {
    const body = ["- [ ] 親", "  - [x] 子", "    - [ ] 孫"].join("\n");

    expect(countTaskListItems(body)).toEqual({ total: 3, completed: 1 });
  });

  it("コードフェンスの中にあるタスク風の行は数えない", () => {
    const body = [
      "- [x] 実際のタスク",
      "",
      "```markdown",
      "- [ ] テンプレートの例示",
      "- [ ] これも例示",
      "```",
      "",
      "- [ ] もうひとつのタスク",
    ].join("\n");

    expect(countTaskListItems(body)).toEqual({ total: 2, completed: 1 });
  });

  it("``` の中の ~~~ ではフェンスが閉じない", () => {
    const body = ["```", "~~~", "- [ ] 例示", "```", "- [ ] 実際のタスク"].join("\n");

    expect(countTaskListItems(body)).toEqual({ total: 1, completed: 0 });
  });

  it("チェックボックスが無い箇条書きは数えない", () => {
    const body = ["- ふつうの箇条書き", "- [不完全] これもタスクではない", "本文の [ ] も数えない"].join("\n");

    expect(countTaskListItems(body)).toEqual({ total: 0, completed: 0 });
  });

  it("空文字なら0件", () => {
    expect(countTaskListItems("")).toEqual({ total: 0, completed: 0 });
  });
});

describe("toggleTaskListLine", () => {
  const body = ["## やること", "", "- [ ] VPSへSSHする", "- [x] .envを書き換える"].join("\n");

  it("指定行をチェック済みにする", () => {
    expect(toggleTaskListLine(body, 3, true)).toBe(
      ["## やること", "", "- [x] VPSへSSHする", "- [x] .envを書き換える"].join("\n"),
    );
  });

  it("指定行のチェックを外す", () => {
    expect(toggleTaskListLine(body, 4, false)).toBe(
      ["## やること", "", "- [ ] VPSへSSHする", "- [ ] .envを書き換える"].join("\n"),
    );
  });

  it("インデントとマーカーを保ったまま書き換える", () => {
    const nested = ["- [ ] 親", "   1. [ ] 子"].join("\n");

    expect(toggleTaskListLine(nested, 2, true)).toBe(["- [ ] 親", "   1. [x] 子"].join("\n"));
  });

  it("同じ状態へのトグルでも本文は壊れない", () => {
    expect(toggleTaskListLine(body, 4, true)).toBe(body);
  });

  it("タスク行でない行を指定したら本文をそのまま返す", () => {
    expect(toggleTaskListLine(body, 1, true)).toBe(body);
    expect(toggleTaskListLine(body, 2, true)).toBe(body);
  });

  it("範囲外の行番号なら本文をそのまま返す", () => {
    expect(toggleTaskListLine(body, 0, true)).toBe(body);
    expect(toggleTaskListLine(body, 99, true)).toBe(body);
  });

  it("行末に文字が無いタスク行も書き換えられる", () => {
    expect(toggleTaskListLine("- [ ]", 1, true)).toBe("- [x]");
  });
});
