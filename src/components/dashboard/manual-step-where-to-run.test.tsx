// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
});

describe("ManualStepWhereToRun", () => {
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

  it("案内できることが無ければ何も出さない", () => {
    const guide = parseManualStepGuide("## 前提条件\n\n- 実行するデバイス: **ブラウザ**\n");
    const { container } = render(
      <ManualStepWhereToRun where={guide.where} device={guide.where.defaultDevice} command={null} />,
    );

    expect(container.textContent).toBe("");
  });
});
