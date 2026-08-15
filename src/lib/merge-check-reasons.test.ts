import { describe, expect, it } from "vitest";

import { resolveMergeCheckReasons } from "@/lib/merge-check-reasons";
import type { IssueComment, IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "64748b", description: null }));
}

function comment(body: string, overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "1",
    author: { login: "github-actions[bot]" },
    createdAtLabel: "3分前",
    body,
    reactionCount: 0,
    ...overrides,
  };
}

/**
 * `reusable-claude-review-develop.yml`の`auto-merge`ジョブが実際に投稿する文面（#1613のコメント）。
 * ワークフロー側の文言を変えたときにここが落ちるようにするため、実物のまま置いている。
 */
const REVIEW_REASON_COMMENT = `⚠️ 以下の理由により、developへのマージ前にユーザーの確認が必要と判定しました。

- GitHub Actionsワークフローの変更 (.github/workflows/**)
- Issueに \`22.merge-confirm-required\` ラベルが付与されているため（developへのマージ前に必ずユーザー確認を行う設定）

<!-- issue-deck-source:claude-review-develop -->`;

describe("resolveMergeCheckReasons", () => {
  it("自動レビューの理由コメントから箇条書きを取り出す", () => {
    expect(resolveMergeCheckReasons(labels(), [comment(REVIEW_REASON_COMMENT)])).toEqual({
      source: "review",
      items: [
        "GitHub Actionsワークフローの変更 (.github/workflows/**)",
        "Issueに `22.merge-confirm-required` ラベルが付与されているため（developへのマージ前に必ずユーザー確認を行う設定）",
        ],
      postedAtLabel: "3分前",
    });
  });

  it("理由コメントが複数あるときは最新のものを採る", () => {
    const older = comment(
      `⚠️ 以下の理由により、developへのマージ前にユーザーの確認が必要と判定しました。

- DBマイグレーションの変更 (prisma/migrations/**)

<!-- issue-deck-source:claude-review-develop -->`,
      { id: "old", createdAtLabel: "2日前" },
    );
    const result = resolveMergeCheckReasons(labels(), [
      older,
      comment(REVIEW_REASON_COMMENT, { id: "new", createdAtLabel: "5分前" }),
    ]);
    expect(result.source).toBe("review");
    expect(result.items[0]).toBe("GitHub Actionsワークフローの変更 (.github/workflows/**)");
    expect(result.postedAtLabel).toBe("5分前");
  });

  it("投稿元マーカーが無いコメントは、同じ文面でも理由として読まない", () => {
    const withoutMarker = comment(
      `⚠️ 以下の理由により、developへのマージ前にユーザーの確認が必要と判定しました。

- 手で書いた引用`,
      { author: { login: "m-guchi" } },
    );
    expect(resolveMergeCheckReasons(labels(), [withoutMarker]).source).toBe("unknown");
  });

  it("定型文はあるが箇条書きが無いコメントは飛ばして、次の候補を見る", () => {
    const empty = comment(
      `⚠️ 以下の理由により、developへのマージ前にユーザーの確認が必要と判定しました。

<!-- issue-deck-source:claude-review-develop -->`,
      { id: "empty", createdAtLabel: "1分前" },
    );
    const result = resolveMergeCheckReasons(labels(), [comment(REVIEW_REASON_COMMENT), empty]);
    expect(result.source).toBe("review");
    expect(result.postedAtLabel).toBe("3分前");
  });

  it("理由コメントが無ければ、ラベルから理由を組み立てる（#594で投稿が省かれた場合）", () => {
    const result = resolveMergeCheckReasons(
      labels("00.check-user", "22.merge-confirm-required", "23.preview-required"),
      [],
    );
    expect(result).toEqual({
      source: "label",
      items: [
        "マージ前の確認が必要な設定（`22.merge-confirm-required`）が付いています",
        "開発環境での確認待ちです（`23.preview-required`）",
      ],
      postedAtLabel: null,
    });
  });

  it("理由コメントがあればラベルより優先する", () => {
    const result = resolveMergeCheckReasons(labels("23.preview-required"), [
      comment(REVIEW_REASON_COMMENT),
    ]);
    expect(result.source).toBe("review");
  });

  it("どちらも無ければ、理由を作らず記録が無いことを伝える", () => {
    const result = resolveMergeCheckReasons(labels("00.check-user", "01.check-merge"), [
      comment("✅ developへのマージが完了しました\n\n<!-- issue-deck-source:issue-labels -->"),
    ]);
    expect(result).toEqual({
      source: "unknown",
      items: ["理由の記録が見つかりませんでした。PRのレビューコメントを確認してください。"],
      postedAtLabel: null,
    });
  });
});
