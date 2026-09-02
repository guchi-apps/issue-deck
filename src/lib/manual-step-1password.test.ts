import { describe, expect, it } from "vitest";

import {
  findManualStepSyncKeys,
  isOnePasswordRegistrationStep,
} from "@/lib/manual-step-1password";
import { parseManualStepGuide } from "@/lib/manual-step-guide";

/** guchi-apps/issue-deck#2572相当。1Password登録の直後にサブPCでの同期コマンドが続く実例 */
const ISSUE_2572 = `## この作業でできるようになること

- できるようになること: 本番のissue-deckでGPTモデルを選べるようになる。

## 前提条件

- 実行するデバイス: ブラウザ
- カレントディレクトリ: 不要
- Gitブランチ: 不要

## やること

- [ ] （ブラウザ）OpenAI Platformでissue-deck用のAPIキーを作成し、1Passwordの\`apps\`ボールトにある\`issue-deck\`アイテムの\`openai-api-key\`フィールドへ登録する

- [ ] （サブPC）1Passwordの値をGitHub Actionsの\`OPENAI_API_KEY\` secretへ同期する

  \`\`\`bash
  cd ~/apps/issue-deck && scripts/provision-secret.sh --repo guchi-apps/issue-deck --key OPENAI_API_KEY --sync-only
  \`\`\`

## 完了の確認方法

- 1Passwordの\`apps\`ボールトで\`issue-deck\`を開き、\`openai-api-key\`フィールドに値が登録されていることを確認します。
`;

describe("isOnePasswordRegistrationStep", () => {
  it("「1Password」と「登録」を含む手順を1Password登録手順と判定する", () => {
    const guide = parseManualStepGuide(ISSUE_2572);
    expect(isOnePasswordRegistrationStep(guide.steps[0])).toBe(true);
  });

  it("同期コマンドの手順は1Password登録手順ではない", () => {
    const guide = parseManualStepGuide(ISSUE_2572);
    expect(isOnePasswordRegistrationStep(guide.steps[1])).toBe(false);
  });

  it("1Passwordに触れない手順はfalse", () => {
    expect(isOnePasswordRegistrationStep({ text: "pollerを再起動する" })).toBe(false);
  });
});

describe("findManualStepSyncKeys", () => {
  it("provision-secret.shの--keyを拾う", () => {
    const guide = parseManualStepGuide(ISSUE_2572);
    expect(findManualStepSyncKeys(guide)).toEqual(["OPENAI_API_KEY"]);
  });

  it("同期コマンドが無ければ空", () => {
    const guide = parseManualStepGuide(
      ["## やること", "", "- [ ] pollerを再起動する"].join("\n"),
    );
    expect(findManualStepSyncKeys(guide)).toEqual([]);
  });

  it("チェックリストに割れていない本文（hasTemplate: false）は空", () => {
    const guide = parseManualStepGuide("自由形式の本文です。");
    expect(findManualStepSyncKeys(guide)).toEqual([]);
  });
});
