import { describe, expect, it } from "vitest";

import type { SessionQuestion } from "@/lib/dispatch/session-question-request";
import { findManualStepForQuestion } from "@/lib/manual-step-question";
import type { IssueLabel } from "@/types/issue";

const MANUAL_STEP_LABELS: IssueLabel[] = [{ name: "71.manual-step", color: "d876e3", description: null }];

const BODY = [
  "## この作業でできるようになること",
  "",
  "- できるようになること: カレンダーの取り込みが動く",
  "",
  "## 前提条件",
  "",
  "- 実行するデバイス: サブPC（`ssh subpc`）",
  "- カレントディレクトリ: `~/apps/issue-deck`",
  "- Gitブランチ: `develop`",
  "",
  "## やること",
  "",
  "- [ ] （ブラウザ）Google Cloud ConsoleでOAuthクライアントを作成し、リフレッシュトークンを取得する",
  "",
  "- [ ] （VPS）`.env`に`GOOGLE_REFRESH_TOKEN`を追加してPM2を再起動する",
  "",
  "  ```bash",
  '  echo "GOOGLE_REFRESH_TOKEN=<控えたrefresh_token>" >> /apps/issue-deck/.env',
  "  ```",
  "",
  "## 完了の確認方法",
  "",
  "- 取り込みが動くこと",
  "",
  "  ```bash",
  "  curl -sf http://localhost:4820/api/health",
  "  ```",
  "",
].join("\n");

function question(overrides: Partial<SessionQuestion> = {}): SessionQuestion {
  return {
    question: "手順1「Google Cloud ConsoleでOAuthクライアントを作成し、リフレッシュトークンを取得する」はブラウザでの作業のため代行できません。実施されましたか？",
    header: "手順1",
    options: [
      { label: "実行した・次へ", description: "本文のチェックを付けて手順2へ進みます" },
      { label: "ここで止める", description: "ここで作業を中断します" },
    ],
    multiSelect: false,
    ...overrides,
  };
}

describe("findManualStepForQuestion", () => {
  it("質問文の手順番号でその手順を当て、実行する端末まで返す", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [question()],
    });

    expect(found?.order).toBe(1);
    expect(found?.total).toBe(2);
    // 手順の文頭の`（ブラウザ）`が、`## 前提条件`の既定値（サブPC）より優先される
    expect(found?.device).toBe("ブラウザ");
    expect(found?.step.text).toContain("Google Cloud Console");
    expect(found?.command).toBeNull();
  });

  it("番号が書かれていなくても、引用された手順名で当てる", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [
        question({
          question: "「`.env`に`GOOGLE_REFRESH_TOKEN`を追加してPM2を再起動する」は実施されましたか？",
          header: "確認",
        }),
      ],
    });

    expect(found?.order).toBe(2);
    expect(found?.device).toBe("VPS");
    expect(found?.command).toContain("GOOGLE_REFRESH_TOKEN");
    // 埋める値が残っている手順は代行できない。その理由を画面へ出せる形で返す
    expect(found?.reason).toContain("値を埋める");
  });

  it("手順に結び付かない質問では当てない（関係のない手順を出さない）", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [
        question({
          question: "全手順が済みました。完了としてクローズしますか？",
          header: "クローズ",
        }),
      ],
    });

    expect(found).toBeNull();
  });

  it("本文の手順数を超える番号では当てない", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [question({ question: "手順5を実行しますか？", header: "手順5" })],
    });

    expect(found).toBeNull();
  });

  it("手作業Issueでなければ当てない", () => {
    const found = findManualStepForQuestion({
      labels: [{ name: "51.improvement", color: "cccccc", description: null }],
      body: BODY,
      questions: [question()],
    });

    expect(found).toBeNull();
  });

  it("テンプレートに沿っていない本文では当てない", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: "手順1をやってください",
      questions: [question()],
    });

    expect(found).toBeNull();
  });
});
