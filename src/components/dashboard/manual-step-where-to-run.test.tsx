// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManualStepWhereToRun,
  buildWhereToRunLines,
} from "@/components/dashboard/manual-step-where-to-run";
import { parseManualStepGuide } from "@/lib/manual-step-guide";

/**
 * 代行実行が失敗したとき、人が自分で実行するための案内（#1882）。
 *
 * 見るのは**本文から拾ったものだけを出す**ことと、`cd`まで含めて並べること
 * （代行実行はホームディレクトリから走るので、`cd`が無いと手元での再現にならない）。
 */

afterEach(cleanup);

const BODY = `## 前提条件

- 実行するデバイス: **サブPC**（メインPCからなら \`ssh subpc\`）
- カレントディレクトリ: \`~/apps/issue-deck\`
- Gitブランチ: \`develop\`
`;

describe("buildWhereToRunLines", () => {
  it("接続 → 移動 → 実行の順に並べる", () => {
    const guide = parseManualStepGuide(BODY);

    expect(buildWhereToRunLines(guide.where, "git pull --ff-only")).toEqual([
      { label: "つなぐ", command: "ssh subpc" },
      { label: "移動する", command: "cd ~/apps/issue-deck" },
      { label: "実行する（本文に書かれたコマンド）", command: "git pull --ff-only" },
    ]);
  });

  // **推測で接続先を作らない。** 書かれていなければその行ごと出さない
  it("接続コマンドが書かれていなければ何も出さない", () => {
    const guide = parseManualStepGuide(
      "## 前提条件\n\n- 実行するデバイス: **ブラウザ**\n- カレントディレクトリ: 不要\n",
    );

    expect(buildWhereToRunLines(guide.where, "gh auth login")).toEqual([]);
  });

  // 「不要」やリポジトリ名だけの記載を`cd`にすると動かない
  it("パスとして読めないカレントディレクトリは移動の行にしない", () => {
    const guide = parseManualStepGuide(
      "## 前提条件\n\n- 実行するデバイス: **VPS**（`ssh vps`）\n- カレントディレクトリ: issue-deckのリポジトリ\n",
    );

    expect(buildWhereToRunLines(guide.where, "vi .env")).toEqual([
      { label: "つなぐ", command: "ssh vps" },
      { label: "実行する（本文に書かれたコマンド）", command: "vi .env" },
    ]);
  });

  // #2818: &&で繋がった確認コマンドを1つずつコピー・実行できるように分ける
  it("&&で繋がったコマンドは実行する行を複数に分ける", () => {
    const guide = parseManualStepGuide(BODY);

    expect(
      buildWhereToRunLines(guide.where, "git fetch origin develop --quiet && git status"),
    ).toEqual([
      { label: "つなぐ", command: "ssh subpc" },
      { label: "移動する", command: "cd ~/apps/issue-deck" },
      { label: "実行する（1/2）", command: "git fetch origin develop --quiet" },
      { label: "実行する（2/2）", command: "git status" },
    ]);
  });
});

describe("ManualStepWhereToRun", () => {
  function mockClipboard(writeText: () => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("実行するデバイスと3行をまとめてコピーできる形で出す", () => {
    const guide = parseManualStepGuide(BODY);
    render(
      <ManualStepWhereToRun
        where={guide.where}
        device={guide.where.defaultDevice}
        command="git pull --ff-only"
      />,
    );

    expect(screen.getByText("手元で実行する（サブPC）")).toBeTruthy();
    expect(screen.getByText("ssh subpc")).toBeTruthy();
    expect(screen.getByText("cd ~/apps/issue-deck")).toBeTruthy();
    expect(screen.getByRole("button", { name: "3行まとめてコピー" })).toBeTruthy();
  });

  // #2818: まとめてコピーだけでなく、1行だけをコピーしたいこともある
  it("行ごとに個別のコピーボタンを出す", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const guide = parseManualStepGuide(BODY);
    render(
      <ManualStepWhereToRun
        where={guide.where}
        device={guide.where.defaultDevice}
        command="git fetch origin develop --quiet && git status"
      />,
    );

    expect(screen.getByText("実行する（1/2）")).toBeTruthy();
    expect(screen.getByText("実行する（2/2）")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "この行をコピー" })[0]);
    expect(writeText).toHaveBeenCalledWith("ssh subpc");
  });

  it("案内できることが無ければ何も出さない", () => {
    const guide = parseManualStepGuide("## 前提条件\n\n- 実行するデバイス: **ブラウザ**\n");
    const { container } = render(
      <ManualStepWhereToRun where={guide.where} device={guide.where.defaultDevice} command={null} />,
    );

    expect(container.textContent).toBe("");
  });
});
