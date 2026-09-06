import { describe, expect, it } from "vitest";

import { buildManualStepSessionPlan } from "@/lib/manual-step-session-plan";

/**
 * 手作業セッションの実行計画（#2830）。
 *
 * 画面が「起動を押した1回で何が流れるのか」を出すための内訳なので、**人に頼む側へ倒っていること**
 * （サブPC以外・埋める値・対話が要るコマンド・コマンドが無い手順）を中心に確かめる。
 * ホストの申告に左右されないこと（セッションは自分の`Bash`で実行する）も、ここで固定する。
 */

const BODY = `## 前提条件

- 実行するデバイス: **サブPC**
- カレントディレクトリ: \`~/apps/issue-deck\`

## やること

- [ ] 本体チェックアウトを更新する

    \`\`\`bash
    cd ~/apps/issue-deck && git pull --ff-only
    \`\`\`

- [ ] （ブラウザ）1Passwordで\`apps\`ボールトの\`aide-bot\`を開き、\`DB_PASSWORD\`を登録する

- [ ] 控えた値をsecretへ同期する

    \`\`\`bash
    scripts/provision-secret.sh --key <控えたkey> --sync-only
    \`\`\`

## 完了の確認方法

- secretが入っていること

    \`\`\`bash
    gh secret list --repo guchi-apps/aide-bot | grep -q DB_PASSWORD
    \`\`\`
`;

describe("buildManualStepSessionPlan", () => {
  it("本文のコマンドを流せる手順と、人に頼む手順を分ける", () => {
    const plan = buildManualStepSessionPlan(BODY, { isManualStepIssue: true });

    expect(plan.entries.map((entry) => entry.kind)).toEqual([
      "step",
      "step",
      "step",
      "verification",
    ]);
    // 流せるのは1つ目の手順と完了の確認。ブラウザの手順と`<控えたkey>`の手順は人が実行する
    expect(plan.auto).toBe(2);
    expect(plan.user).toBe(2);
    expect(plan.entries[1].device).toBe("ブラウザ");
    expect(plan.entries[1].rejection).toBe("device_not_subpc");
    expect(plan.entries[2].rejection).toBe("placeholder_command");
    expect(plan.entries[2].placeholder).toBe("<控えたkey>");
  });

  it("対話が要るコマンドの手順は人に頼む", () => {
    const body = `## 前提条件

- 実行するデバイス: **サブPC**

## やること

- [ ] 1Passwordへサインインして読む

    \`\`\`bash
    op signin && op read 'op://apps/aide-bot/DB_PASSWORD'
    \`\`\`
`;
    const plan = buildManualStepSessionPlan(body, { isManualStepIssue: true });

    expect(plan.auto).toBe(0);
    expect(plan.entries[0].rejection).toBe("interactive_command");
    expect(plan.entries[0].interactiveCommand).toBe("op signin");
  });

  it("チェック済みの手順は数に入れない", () => {
    const body = BODY.replace("- [ ] 本体チェックアウトを更新する", "- [x] 本体チェックアウトを更新する");
    const plan = buildManualStepSessionPlan(body, { isManualStepIssue: true });

    expect(plan.entries).toHaveLength(4);
    expect(plan.auto).toBe(1);
    expect(plan.user).toBe(2);
  });

  it("手作業Issueでなければ1件も流さない", () => {
    const plan = buildManualStepSessionPlan(BODY, { isManualStepIssue: false });

    expect(plan.auto).toBe(0);
    expect(plan.entries.every((entry) => entry.rejection === "not_manual_step")).toBe(true);
  });
});
