import { describe, expect, it } from "vitest";

import {
  MANUAL_STEP_INVESTIGATION_MARKER,
  MANUAL_STEP_VERIFICATION_MARKER,
  findLatestManualStepInvestigation,
  findLatestManualStepVerification,
  parseManualStepInvestigation,
  parseManualStepVerification,
} from "@/lib/manual-step-investigation";
import type { IssueComment } from "@/types/issue";

function comment(body: string, authorTrusted = true): IssueComment {
  return {
    id: "1",
    author: { login: "bot", avatarUrl: "" },
    authorTrusted,
    createdAtLabel: "",
    body,
    reactionCount: 0,
  } as unknown as IssueComment;
}

const investigation = `${MANUAL_STEP_INVESTIGATION_MARKER}
## 事前調査
### 目的
aide-botをDBへ接続する
### AI実施済み
- DB未作成を確認（根拠: SHOW DATABASES）
### 自動実行できる
- DB作成
### あなたの操作
- DBパスワードの登録（理由: 秘密値のためAIは発行できない）
\`\`\`
cd ~/apps/aide-bot && op item create --title=x
\`\`\`
`;

describe("parseManualStepInvestigation", () => {
  it("4分類とコマンドを読む", () => {
    const parsed = parseManualStepInvestigation(investigation);
    expect(parsed?.purpose).toBe("aide-botをDBへ接続する");
    expect(parsed?.done).toEqual(["DB未作成を確認（根拠: SHOW DATABASES）"]);
    expect(parsed?.auto).toEqual(["DB作成"]);
    expect(parsed?.user[0].command).toBe("cd ~/apps/aide-bot && op item create --title=x");
  });

  it("マーカーが無ければnull", () => {
    expect(parseManualStepInvestigation("### 目的\nx")).toBeNull();
  });

  it("信頼できない投稿者のコメントは読まない", () => {
    expect(findLatestManualStepInvestigation([comment(investigation, false)])).toBeNull();
    expect(findLatestManualStepInvestigation([comment(investigation)])).not.toBeNull();
  });
});

describe("parseManualStepVerification", () => {
  it("すべて終了コード0のときだけpassed", () => {
    const ok = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード0: \`curl -fsS x\`\n`;
    const ng = `${ok}- 終了コード22: \`test -f y\`\n`;
    expect(parseManualStepVerification(ok)?.passed).toBe(true);
    expect(parseManualStepVerification(ng)?.passed).toBe(false);
  });

  it("コマンドが1件も無い報告は完了とみなさない", () => {
    expect(parseManualStepVerification(MANUAL_STEP_VERIFICATION_MARKER)?.passed).toBe(false);
  });

  it("最新の報告を使う", () => {
    const ng = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード1: \`a\`\n`;
    const ok = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード0: \`a\`\n`;
    expect(findLatestManualStepVerification([comment(ng), comment(ok)])?.passed).toBe(true);
  });
});

describe("実行能力と完了条件ごとの記録（#4522）", () => {
  it("「実行能力」の節を読む", () => {
    const body = `${MANUAL_STEP_INVESTIGATION_MARKER}\n### 目的\nx\n### 実行能力\n- browser-binary: ok（subpc・2026-10-18 10:00）\n- browser-login: missing（認証済みプロファイル無し）\n`;
    expect(parseManualStepInvestigation(body)?.capabilities).toEqual([
      "browser-binary: ok（subpc・2026-10-18 10:00）",
      "browser-login: missing（認証済みプロファイル無し）",
    ]);
  });

  it("終了コード0でも、条件が未達なら完了にしない", () => {
    const body = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード0: \`true\`\n- 条件: 画面に設定が出る / 結果: 未達 / 確認: 10:05 / 根拠: スクリーンショットで確認\n`;
    const parsed = parseManualStepVerification(body);
    expect(parsed?.conditions).toHaveLength(1);
    expect(parsed?.passed).toBe(false);
  });

  it("全条件が達成なら完了", () => {
    const body = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード0: \`true\`\n- 条件: 画面に設定が出る / 結果: 達成 / 確認: 10:05 / 根拠: DOMを確認\n`;
    expect(parseManualStepVerification(body)?.passed).toBe(true);
  });
});
