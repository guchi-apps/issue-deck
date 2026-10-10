// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManualStepWhereToRun,
  buildManualStepOneLiner,
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

describe("buildManualStepOneLiner（#4315）", () => {
  it("接続・移動・実行を1行にまとめ、リモートはssh先でcdから始める", () => {
    const guide = parseManualStepGuide(BODY);

    expect(buildManualStepOneLiner(guide.where, "git pull --ff-only")).toBe(
      "ssh subpc 'cd ~/apps/issue-deck && git pull --ff-only'",
    );
  });

  // **推測で接続先を作らない。** 書かれていなければ組み込まない
  it("接続コマンドも移動先も無ければnull", () => {
    const guide = parseManualStepGuide(
      "## 前提条件\n\n- 実行するデバイス: **ブラウザ**\n- カレントディレクトリ: 不要\n",
    );

    expect(buildManualStepOneLiner(guide.where, "gh auth login")).toBeNull();
  });

  // 「不要」やリポジトリ名だけの記載を`cd`にすると動かない
  it("パスとして読めないカレントディレクトリは移動に含めない", () => {
    const guide = parseManualStepGuide(
      "## 前提条件\n\n- 実行するデバイス: **VPS**（`ssh vps`）\n- カレントディレクトリ: issue-deckのリポジトリ\n",
    );

    expect(buildManualStepOneLiner(guide.where, "vi .env")).toBe("ssh vps 'vi .env'");
  });

  it("手元の端末ではsshを付けず、cd && …から始める", () => {
    const guide = parseManualStepGuide(
      "## 前提条件\n\n- 実行するデバイス: **メインPC**（`ssh subpc`）\n- カレントディレクトリ: `~/apps/x`\n",
    );

    expect(buildManualStepOneLiner(guide.where, "pnpm build")).toBe("cd ~/apps/x && pnpm build");
  });

  it("&&や改行で繋がったコマンドも1行にまとめ、シングルクォートを壊さない", () => {
    const guide = parseManualStepGuide(BODY);

    expect(buildManualStepOneLiner(guide.where, "echo 'a'\ngit status")).toBe(
      "ssh subpc 'cd ~/apps/issue-deck && echo '\\''a'\\'' && git status'",
    );
  });
});

describe("ManualStepWhereToRun", () => {
  function mockClipboard(writeText: () => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("実行先と1行を出し、番号は出さない", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const guide = parseManualStepGuide(BODY);
    render(
      <ManualStepWhereToRun
        where={guide.where}
        device={guide.where.defaultDevice}
        command="git pull --ff-only"
      />,
    );

    expect(screen.getByText("手元で実行する（サブPC）")).toBeTruthy();
    expect(screen.getByText("ssh subpc 'cd ~/apps/issue-deck && git pull --ff-only'")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "この行をコピー" }));
    expect(writeText).toHaveBeenCalledWith("ssh subpc 'cd ~/apps/issue-deck && git pull --ff-only'");
  });

  it("案内できることが無ければ何も出さない", () => {
    const guide = parseManualStepGuide("## 前提条件\n\n- 実行するデバイス: **ブラウザ**\n");
    const { container } = render(
      <ManualStepWhereToRun where={guide.where} device={guide.where.defaultDevice} command={null} />,
    );

    expect(container.textContent).toBe("");
  });
});
