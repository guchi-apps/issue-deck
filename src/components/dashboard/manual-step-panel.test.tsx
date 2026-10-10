// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualStepPanel } from "@/components/dashboard/manual-step-panel";
import {
  MANUAL_STEP_INVESTIGATION_MARKER,
  MANUAL_STEP_VERIFICATION_MARKER,
} from "@/lib/manual-step-investigation";
import type { IssueComment } from "@/types/issue";
import { detectInfraConfigTargets } from "@/lib/infra-config-repos";
import {
  summarizeManualStepPrerequisites,
  type ManualStepPrerequisite,
} from "@/lib/manual-step-prerequisites";

const REPO = "guchi-apps/issue-deck";

function prerequisite(overrides: Partial<ManualStepPrerequisite> = {}): ManualStepPrerequisite {
  return {
    repositoryFullName: REPO,
    number: 1690,
    origin: false,
    explicit: true,
    kind: "issue",
    title: "右パネルから進捗を変えられるようにする",
    htmlUrl: `https://github.com/${REPO}/issues/1690`,
    stage: "develop",
    label: "developへマージ済み・本番未反映",
    satisfied: false,
    stepIndex: 1,
    manualStep: false,
    ...overrides,
  };
}

function renderWithPrerequisites(prerequisites: ManualStepPrerequisite[]) {
  render(
    <ManualStepPanel
      isSubmitting={false}
      prerequisites={prerequisites}
      prerequisiteSummary={summarizeManualStepPrerequisites(prerequisites, REPO)}
      repositoryFullName={REPO}
    />,
  );
}

describe("ManualStepPanel", () => {
  afterEach(() => {
    cleanup();
  });

  // #2003: 自分が終わるまで何が止まっているのかは、後回しにしてよいかの判断に一番効く
  it("このIssueの完了を待っているIssueを、前提条件の下に出す", () => {
    render(
      <ManualStepPanel
        isSubmitting={false}
        dependents={[
          {
            id: "38",
            repositoryFullName: REPO,
            number: 38,
            title: "セルフホストランナーが落ちたまま復帰しない",
            htmlUrl: `https://github.com/${REPO}/issues/38`,
            stage: "in-progress",
            label: "実装中",
            stepIndex: 0,
            manualStep: false,
          },
        ]}
        repositoryFullName={REPO}
      />,
    );

    expect(screen.getByText("このIssueの完了を待っているIssue")).toBeTruthy();
    expect(screen.getByText("このIssueが終わるまで #38 は先へ進めません。")).toBeTruthy();
  });

  // #4315: 旧3ボタン（順番に進める・手作業を完了してクローズ・実施せずクローズ）は持たない
  it("旧ウィザード・自己申告の完了ボタンを出さない", () => {
    render(<ManualStepPanel isSubmitting={false} />);

    expect(screen.queryByRole("button", { name: "順番に進める" })).toBeNull();
    expect(screen.queryByRole("button", { name: /クローズ/ })).toBeNull();
    expect(screen.queryByText(/手順\s*\d/)).toBeNull();
  });

  describe("作業の状況（#4315）", () => {
    const ISSUE = { repositoryFullName: REPO, number: 1, labels: [], body: "## やること\n" };
    function comment(body: string) {
      return {
        id: "c1",
        author: { login: "bot" },
        authorTrusted: true,
        createdAtLabel: "",
        body,
        reactionCount: 0,
      } as unknown as IssueComment;
    }

    it("調査報告が無いときは「未確認」と出し、調査済みと取り違えない", () => {
      render(<ManualStepPanel isSubmitting={false} sessionIssue={ISSUE as never} comments={[]} />);

      expect(screen.getByText("作業の状況")).toBeTruthy();
      expect(screen.getAllByText(/未確認/).length).toBeGreaterThan(0);
    });

    it("調査報告の4分類と1ライナーを出し、コピーできる", () => {
      const body = [
        MANUAL_STEP_INVESTIGATION_MARKER,
        "### 目的",
        "DBを作る",
        "### AI実施済み",
        "- DB未作成を確認",
        "### 自動実行できる",
        "- DB作成",
        "### あなたの操作",
        "- パスワードの登録（理由: 秘密値）",
        "```",
        "cd ~/apps/x && op item create",
        "```",
      ].join("\n");
      render(
        <ManualStepPanel
          isSubmitting={false}
          sessionIssue={ISSUE as never}
          comments={[comment(body)]}
        />,
      );

      expect(screen.getByText("AIが実施済み")).toBeTruthy();
      expect(screen.getByText("DB未作成を確認")).toBeTruthy();
      expect(screen.getByText("パスワードの登録（理由: 秘密値）")).toBeTruthy();
      expect(screen.getByText("cd ~/apps/x && op item create")).toBeTruthy();
      expect(screen.getByRole("button", { name: /コピー/ })).toBeTruthy();
    });

    it("検証が失敗した報告は完了にせず、理由の確認を促す", () => {
      const body = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード22: \`curl -fsS x\`\n`;
      render(
        <ManualStepPanel
          isSubmitting={false}
          sessionIssue={ISSUE as never}
          comments={[comment(body)]}
        />,
      );

      expect(screen.getByText(/完了にはなりません/)).toBeTruthy();
      expect(screen.getByText("検証失敗・未完了")).toBeTruthy();
    });

    it("検証がすべて成功した報告は「検証済み」にする", () => {
      const body = `${MANUAL_STEP_VERIFICATION_MARKER}\n- 終了コード0: \`curl -fsS x\`\n`;
      render(
        <ManualStepPanel
          isSubmitting={false}
          sessionIssue={ISSUE as never}
          comments={[comment(body)]}
        />,
      );

      expect(screen.getByText("検証済み")).toBeTruthy();
    });
  });

  it("前提条件が揃っていなければ、待っている相手と何を待っているかを出す", () => {
    renderWithPrerequisites([
      prerequisite({ origin: true }),
      prerequisite({
        number: 1704,
        kind: "pull-request",
        title: "デプロイ完了を通知する",
        stage: "open",
        label: "マージ待ち",
        stepIndex: null,
      }),
    ]);

    expect(screen.getByText("前提条件の状況")).toBeTruthy();
    expect(screen.getByText("2件中 0件 完了")).toBeTruthy();
    expect(
      screen.getByText("まだ実行できません。#1690 がmainへ反映されるのを待ってください（ほか1件）。"),
    ).toBeTruthy();
    expect(screen.getByText("起点")).toBeTruthy();
    expect(screen.getByText("PR #1704")).toBeTruthy();
  });

  it("前提条件がすべて満たされていれば実行できる旨を出す", () => {
    renderWithPrerequisites([
      prerequisite({ stage: "done-main", label: "mainへ反映済み", satisfied: true, stepIndex: 2 }),
    ]);

    expect(screen.getByText("前提はすべて満たされています。いま実行できます。")).toBeTruthy();
    expect(screen.getByText("mainへ反映済み")).toBeTruthy();
  });

  it("参照が1件も無ければ前提条件のブロックごと出さない", () => {
    renderWithPrerequisites([]);

    expect(screen.queryByText("前提条件の状況")).toBeNull();
  });

  // 完了確認の定期巡回（#2008）
  it("確認コマンドが通っていれば「完了済みの可能性」を出す", () => {
    render(
      <ManualStepPanel
        isSubmitting={false}
        verifiedAt="2026-08-20T00:12:00.000Z"
        repositoryFullName={REPO}
      />,
    );

    expect(screen.getByText("完了済みの可能性があります。")).toBeTruthy();
    // 断定はしない（終了コードしか見ていないため、確かめるのは人）
    expect(screen.getByText(/セッションの完了検証で確かめます/)).toBeTruthy();
  });

  it("通っていなければ何も出さない", () => {
    render(
      <ManualStepPanel
        isSubmitting={false}
        verifiedAt={null}
        repositoryFullName={REPO}
      />,
    );

    expect(screen.queryByText("完了済みの可能性があります。")).toBeNull();
  });
});

/**
 * #2021: 実機のファイル変更をリポジトリ経由へ寄せる導線。検出そのものは
 * `lib/infra-config-repos.ts`のテストで見ているので、ここでは出し分けと押したときだけを見る。
 */
describe("ManualStepPanel（設定変更Issueの切り出し）", () => {
  afterEach(() => {
    cleanup();
  });

  const CONFIG_BODY = `## 前提条件

- 実行するデバイス: **VPS**

## やること

- [ ] VirtualHostを配置する

    \`\`\`bash
    sudo cp aide.gucchii.com.conf /etc/apache2/sites-available/aide.gucchii.com.conf
    \`\`\`
`;

  it("当たった手順があるとき、切り出し先とボタンを出す", () => {
    const onCreateConfigIssue = vi.fn();
    const targets = detectInfraConfigTargets(CONFIG_BODY);
    render(
      <ManualStepPanel
        isSubmitting={false}
        configTargets={targets}
        onCreateConfigIssue={onCreateConfigIssue}
        repositoryFullName={REPO}
      />,
    );

    expect(screen.getByText("リポジトリ経由で反映できます")).toBeTruthy();
    expect(screen.getByText("guchi-apps/vps")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /設定変更Issueを作る/ }));
    expect(onCreateConfigIssue).toHaveBeenCalledWith(targets[0]);
  });

  it("当たった手順が無ければ何も出さない", () => {
    render(
      <ManualStepPanel
        isSubmitting={false}
        configTargets={[]}
        onCreateConfigIssue={vi.fn()}
        repositoryFullName={REPO}
      />,
    );

    expect(screen.queryByText("リポジトリ経由で反映できます")).toBeNull();
  });

  // 切り出す先を持たない画面（渡していない呼び出し元）で、押せない導線を出さない
  it("切り出しのハンドラを渡していなければ出さない", () => {
    render(
      <ManualStepPanel
        isSubmitting={false}
        configTargets={detectInfraConfigTargets(CONFIG_BODY)}
        repositoryFullName={REPO}
      />,
    );

    expect(screen.queryByText("リポジトリ経由で反映できます")).toBeNull();
  });
});
