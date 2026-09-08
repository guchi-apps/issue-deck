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

describe("進み具合（#2830）", () => {
  it("済んだ手順と、残りのうち人が実行する手順を数える", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [question()],
    });

    // どちらの手順も代行できない（ブラウザ／`<控えたrefresh_token>`を含む）
    expect(found?.progress).toEqual({ done: 0, total: 2, remaining: 2, remainingByUser: 2 });
  });

  it("チェック済みの手順は済んだ側へ数え、残りから外す", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY.replace(
        "- [ ] （ブラウザ）Google Cloud Console",
        "- [x] （ブラウザ）Google Cloud Console",
      ),
      questions: [
        question({
          question:
            "手順2「`.env`に`GOOGLE_REFRESH_TOKEN`を追加してPM2を再起動する」は埋める値を含むため代行できません。実施されましたか？",
          header: "手順2",
        }),
      ],
    });

    expect(found?.progress).toEqual({ done: 1, total: 2, remaining: 1, remainingByUser: 1 });
  });

  it("サブPCで流せる手順は「あなたが実行」に数えない", () => {
    const body = BODY.replace(
      "- [ ] （VPS）`.env`に`GOOGLE_REFRESH_TOKEN`を追加してPM2を再起動する",
      "- [ ] （サブPC）pollerを再起動する",
    ).replace(
      'echo "GOOGLE_REFRESH_TOKEN=<控えたrefresh_token>" >> /apps/issue-deck/.env',
      "systemctl --user restart issue-deck-dispatch-poller.service",
    );
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body,
      questions: [question()],
    });

    expect(found?.progress).toEqual({ done: 0, total: 2, remaining: 2, remainingByUser: 1 });
  });
});

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
    // 代行できない理由は`describeManualStepExecutionRejection`の文言をそのまま返す
    // （手作業アシスタントの`ManualStepRunPanel`と同じ文になる）。**VPSは#2901で代行できる
    // ようになった**ので、この手順が止まる理由は端末ではなく埋める値の方になる——順序も
    // 既存の判定（`runTarget` → コマンド → 対話 → プレースホルダ）に従う
    expect(found?.reason).toContain("<控えたrefresh_token>");
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

  it("手順名が引用されていなければ、番号だけでは当てない", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [question({ question: "手順2を実行しますか？", header: "手順2" })],
    });

    expect(found).toBeNull();
  });

  /**
   * プロンプトは「未チェックのものだけ進める」とも書いているため、モデルが残りの手順を
   * 1から数え直すと番号だけが当たる。番号と手順名が食い違うときは出さない（計画レビューの指摘2）。
   */
  it("番号と手順名が別の手順を指していたら当てない", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [
        question({
          question: "手順1「`.env`に`GOOGLE_REFRESH_TOKEN`を追加してPM2を再起動する」は実施されましたか？",
          header: "手順1",
        }),
      ],
    });

    expect(found).toBeNull();
  });

  it("ブラウザの手順では、代行できない理由も手作業アシスタントと同じ文言で返す", () => {
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body: BODY,
      questions: [question()],
    });

    expect(found?.reason).toContain("ブラウザで実行するため");
  });

  it("手作業Issueでなければ当てない", () => {
    const found = findManualStepForQuestion({
      labels: [{ name: "51.improvement", color: "cccccc", description: null }],
      body: BODY,
      questions: [question()],
    });

    expect(found).toBeNull();
  });

  it("サブPCの手順に埋める値が残っていれば、その表記を添えて理由にする", () => {
    const body = [
      "## 前提条件",
      "",
      "- 実行するデバイス: サブPC",
      "",
      "## やること",
      "",
      "- [ ] `.env`にトークンを追記する",
      "",
      "  ```bash",
      '  echo "TOKEN=<控えたkey>" >> .env',
      "  ```",
      "",
    ].join("\n");
    const found = findManualStepForQuestion({
      labels: MANUAL_STEP_LABELS,
      body,
      questions: [
        question({ question: "手順1「`.env`にトークンを追記する」は実施されましたか？", header: "手順1" }),
      ],
    });

    expect(found?.reason).toContain("<控えたkey>");
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
