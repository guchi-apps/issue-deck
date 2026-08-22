// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MergeCheckReasonNotice } from "@/components/dashboard/merge-check-reason-notice";

describe("MergeCheckReasonNotice", () => {
  afterEach(() => {
    cleanup();
  });

  it("理由の箇条書きと、出所・投稿時刻を出す", () => {
    render(
      <MergeCheckReasonNotice
        reasons={{
          source: "review",
          items: ["GitHub Actionsワークフローの変更 (.github/workflows/**)"],
          postedAtLabel: "3分前",
        }}
      />,
    );
    expect(screen.getByText("自動マージされなかった理由")).not.toBeNull();
    expect(screen.getByText("GitHub Actionsワークフローの変更 (.github/workflows/**)")).not.toBeNull();
    expect(screen.getByText("自動レビューの判定 · 3分前")).not.toBeNull();
  });

  it("バックティックで囲まれたラベル名はインラインコードとして描く（記号を生で出さない）", () => {
    const { container } = render(
      <MergeCheckReasonNotice
        reasons={{
          source: "review",
          items: ["Issueに `22.merge-confirm-required` ラベルが付与されているため"],
          postedAtLabel: null,
        }}
      />,
    );
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("22.merge-confirm-required");
    expect(container.textContent).not.toContain("`");
  });

  it("`**`で囲まれた該当カテゴリは太字として描く（記号を生で出さない）", () => {
    const { container } = render(
      <MergeCheckReasonNotice
        reasons={{
          source: "review",
          items: [
            "**GitHub Actionsやデプロイ設定**: `.github/workflows/deploy.yml` を変更している",
          ],
          postedAtLabel: null,
        }}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("GitHub Actionsやデプロイ設定");
    expect(container.querySelector("code")?.textContent).toBe(".github/workflows/deploy.yml");
    expect(container.textContent).not.toContain("*");
    expect(container.textContent).not.toContain("`");
  });

  it("ラベル由来のときは投稿時刻を持たないので、出所だけを出す", () => {
    render(
      <MergeCheckReasonNotice
        reasons={{
          source: "label",
          items: ["マージ前の確認が必要な設定（`22.merge-confirm-required`）が付いています"],
          postedAtLabel: null,
        }}
      />,
    );
    expect(screen.getByText("Issueのラベルから判定")).not.toBeNull();
  });

  it("出所が不明なときは出所の行を出さない", () => {
    render(
      <MergeCheckReasonNotice
        reasons={{
          source: "unknown",
          items: ["理由の記録が見つかりませんでした。PRのレビューコメントを確認してください。"],
          postedAtLabel: null,
        }}
      />,
    );
    expect(screen.queryByText("自動レビューの判定")).toBeNull();
    expect(screen.queryByText("Issueのラベルから判定")).toBeNull();
    expect(
      screen.getByText("理由の記録が見つかりませんでした。PRのレビューコメントを確認してください。"),
    ).not.toBeNull();
  });
});
