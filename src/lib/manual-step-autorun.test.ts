import { describe, expect, it } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import {
  buildManualStepRunPlan,
  describeManualStepRunPlan,
  findManualStepEntry,
  findNextManualStepEntry,
} from "@/lib/manual-step-autorun";

/**
 * 自動実行の実行計画（#1869）。
 *
 * 承認1回で流す範囲を決める場所なので、**流さない側へ倒っていること**
 * （代行できない手順で止まる・チェック済みは飛ばす）を中心に確かめる。
 */

/** テンプレートどおりに書かれた手作業Issueの本文（手順2件＋確認1件） */
const BODY = `## この作業でできるようになること

- **できるようになること**: pollerが新しい版になる。

## 前提条件

- 実行するデバイス: **サブPC**
- カレントディレクトリ: \`~/apps/issue-deck\`

## やること

- [ ] 本体チェックアウトを更新する

    \`\`\`bash
    cd ~/apps/issue-deck && git pull --ff-only
    \`\`\`

- [ ] pollerを再起動する

    \`\`\`bash
    systemctl --user restart issue-deck-dispatch-poller.service
    \`\`\`

- [ ] 画面から「承認して実行」が押せることを見る

## 完了の確認方法

- 遅れが0であること

    \`\`\`bash
    git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop
    \`\`\`
`;

const READY_HOST: Pick<DispatchHostView, "online" | "manualStepCapable"> = {
  online: true,
  manualStepCapable: true,
};

function plan(body = BODY, host = READY_HOST as typeof READY_HOST | null) {
  return buildManualStepRunPlan(body, undefined, { host, isManualStepIssue: true });
}

describe("buildManualStepRunPlan", () => {
  it("手順 → 完了の確認の順に並べ、代行できるものを数える", () => {
    const result = plan();

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "step",
      "step",
      "step",
      "verification",
    ]);
    // コマンドの無い3つ目の手順は人が実行する
    expect(result.runnable).toBe(3);
    expect(result.blocked).toBe(1);
    expect(describeManualStepRunPlan(result)).toBe("手順2件・確認1件");
  });

  it("コマンドが1つに定まらない手順には理由が付く（代行しない）", () => {
    const entry = plan().entries[2];

    expect(entry.command).toBeNull();
    expect(entry.rejection).toBe("no_command");
  });

  it("サブPC以外で実行する手作業は、すべての項目が代行できない", () => {
    const result = plan(BODY.replace("実行するデバイス: **サブPC**", "実行するデバイス: **VPS**"));

    expect(result.runnable).toBe(0);
    expect(result.entries.every((entry) => entry.rejection === "device_not_subpc")).toBe(true);
  });

  it("pollerが未対応・応答なしのときも、判定はディスパッチ側と同じ理由を返す", () => {
    expect(plan(BODY, null).entries[0].rejection).toBe("host_unknown");
    expect(plan(BODY, { online: false, manualStepCapable: true }).entries[0].rejection).toBe(
      "host_offline",
    );
    expect(plan(BODY, { online: true, manualStepCapable: null }).entries[0].rejection).toBe(
      "manual_step_unsupported",
    );
  });

  it("チェック済みの手順は数に入れない（実行済みのものを流し直さない）", () => {
    const result = plan(BODY.replace("- [ ] 本体チェックアウトを更新する", "- [x] 本体チェックアウトを更新する"));

    expect(result.entries[0].checked).toBe(true);
    expect(result.runnable).toBe(2);
    expect(describeManualStepRunPlan(result)).toBe("手順1件・確認1件");
  });

  it("チェックリストで書かれていない本文では、確認だけが並ぶ", () => {
    const body = `## 前提条件

- 実行するデバイス: サブPC

## やること

まとめて実行する。

## 完了の確認方法

\`\`\`bash
echo ok
\`\`\`
`;
    const result = plan(body);

    expect(result.entries.map((entry) => entry.kind)).toEqual(["verification"]);
    expect(describeManualStepRunPlan(result)).toBe("完了の確認1件");
  });
});

describe("findNextManualStepEntry", () => {
  it("先頭から順に返す", () => {
    const result = plan();

    expect(findNextManualStepEntry(result)?.line).toBe(result.entries[0].line);
  });

  it("流し終えた行は飛ばす（確認にはチェックが無いので記録で飛ばす）", () => {
    const result = plan();
    const done = new Set([result.entries[0].line, result.entries[1].line]);

    expect(findNextManualStepEntry(result, done)?.line).toBe(result.entries[2].line);
  });

  it("チェック済みの手順は飛ばす", () => {
    const result = plan(BODY.replace("- [ ] 本体チェックアウトを更新する", "- [x] 本体チェックアウトを更新する"));

    expect(findNextManualStepEntry(result)?.line).toBe(result.entries[1].line);
  });

  // 代行できない手順を飛ばすと、人が実行する前提の手順を跨いで次のコマンドが走る
  it("代行できない手順も返す（止まるかどうかは呼び出し側が決める）", () => {
    const result = plan();
    const done = new Set([result.entries[0].line, result.entries[1].line]);
    const next = findNextManualStepEntry(result, done);

    expect(next?.rejection).toBe("no_command");
  });

  it("すべて終わればnull", () => {
    const result = plan();
    const done = new Set(result.entries.map((entry) => entry.line));

    expect(findNextManualStepEntry(result, done)).toBeNull();
  });
});

describe("findManualStepEntry", () => {
  it("行番号で引ける", () => {
    const result = plan();
    const target = result.entries[3];

    expect(findManualStepEntry(result, target.line)?.kind).toBe("verification");
    expect(findManualStepEntry(result, 1)).toBeNull();
  });
});
