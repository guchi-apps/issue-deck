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

/**
 * レビューエージェント（二次判定）が自由文で書いた理由コメントの実物（Issue #1849）。
 * 定型文の見出し語をどれも含まないため、#2062より前は`unknown`へ落ちていた。
 */
const FREEFORM_REASON_COMMENT = `## PR #1850 自動レビュー結果（自動マージ不可カテゴリの判定）

このPRは以下の観点から「自動マージ不可カテゴリ」に該当すると判定しました。

- **GitHub Actionsやデプロイ設定**: \`.github/workflows/deploy.yml\` の本番デプロイジョブを変更している
- **Secretsや環境変数**: \`.github/secrets-manifest.tsv\` からPORTの1Password参照を削除している

\`risk-check\`ジョブのパスパターン判定（一次判定）に加え、diffの内容を読んだ二次判定でも該当すると判断したため、\`00.check-user\`・\`01.check-merge\`を付与しました。

<!-- issue-deck-source:claude-review-develop -->`;

/**
 * 同じレビューエージェントが投稿する**レビュー本文**の実物（Issue #1849）。理由の箇条書きは
 * 持たないのに「自動マージ不可」の見出しを持つため、ここから節をまたいで箇条書きを拾うと
 * 総評や気になった点が理由として表示されてしまう。
 */
const FULL_REVIEW_COMMENT = `## PR #1850 自動レビュー結果

### 総評: 要確認

### 内容確認
- Issue #1849 の「やること」3項目はすべて満たされています。
- 差分は上記3ファイルのみで、Issue外の変更の混入はありません。

### 自動マージ不可カテゴリ判定
該当します（GitHub Actionsやデプロイ設定・Secretsや環境変数）。ラベルは既に付与済みです。

### 共有知識への追加提案
提案は見当たらず、審査対象はありませんでした。

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

  it("レビューエージェントが自由文で書いた二次判定からも理由を取り出す（#1849）", () => {
    expect(resolveMergeCheckReasons(labels(), [comment(FREEFORM_REASON_COMMENT)])).toEqual({
      source: "review",
      items: [
        "**GitHub Actionsやデプロイ設定**: `.github/workflows/deploy.yml` の本番デプロイジョブを変更している",
        "**Secretsや環境変数**: `.github/secrets-manifest.tsv` からPORTの1Password参照を削除している",
      ],
      postedAtLabel: "3分前",
    });
  });

  it("レビュー本文の箇条書き（総評・内容確認）は理由として拾わない", () => {
    expect(resolveMergeCheckReasons(labels(), [comment(FULL_REVIEW_COMMENT)]).source).toBe(
      "unknown",
    );
  });

  it("自由文の二次判定より、後から投稿された定型文の理由を優先する（#2042の並び）", () => {
    // #2042の自由文コメントは、箇条書きの1つ目が「該当しない側の補足」で理由になっていない。
    // 定型文が別コメントとして残るので、そちらを正として採る。
    const freeform = comment(
      `## 自動マージ不可カテゴリの判定（claude-review-develop）

PR #2043 は \`.github/workflows/reusable-release-develop-to-main.yml\` を変更しており、該当します。

- 変更内容自体は案内文の差し替えのみで、ワークフローの実際の挙動は変えていません
- ただし、変更ファイルが \`.github/workflows/\` 配下であること自体がカテゴリの該当理由です

<!-- issue-deck-source:claude-review-develop -->`,
      { id: "freeform", createdAtLabel: "10分前" },
    );
    const result = resolveMergeCheckReasons(labels(), [
      comment(REVIEW_REASON_COMMENT, { id: "template", createdAtLabel: "20分前" }),
      freeform,
    ]);
    expect(result.source).toBe("review");
    expect(result.postedAtLabel).toBe("20分前");
    expect(result.items[0]).toBe("GitHub Actionsワークフローの変更 (.github/workflows/**)");
  });

  it("issue-deck-agentマーカーが併記されていても理由として読む（ローカルのレビューセッション）", () => {
    const fromLocalReviewer = comment(
      `⚠️ 以下の理由により、developへのマージ前にユーザーの確認が必要と判定しました。

- 認証・認可関連ファイルの変更 (**/auth/**)

<!-- issue-deck-source:claude-review-develop -->

<!-- issue-deck-agent:reviewer -->`,
      { author: { login: "m-guchi" } },
    );
    expect(resolveMergeCheckReasons(labels(), [fromLocalReviewer]).items).toEqual([
      "認証・認可関連ファイルの変更 (**/auth/**)",
    ]);
  });

  it("レビュー本文が後から投稿されても、理由コメントの方を採る（#1849の並び）", () => {
    const result = resolveMergeCheckReasons(labels(), [
      comment(FREEFORM_REASON_COMMENT, { id: "reason", createdAtLabel: "2時間前" }),
      comment(FULL_REVIEW_COMMENT, { id: "review", createdAtLabel: "3分前" }),
    ]);
    expect(result.source).toBe("review");
    expect(result.postedAtLabel).toBe("2時間前");
  });

  it("自動マージの実行が失敗したときの定型文からも理由を取り出す（#2062）", () => {
    const fallback = comment(`⚠️ 以下の理由により、developへのマージ前にユーザーの確認が必要です。

- 自動マージ（auto-merge）の有効化に失敗したため、ユーザーのマージ操作が必要です
- GitHub Actionsワークフローの変更 (.github/workflows/**)

実行ログ: https://github.com/guchi-apps/issue-deck/actions/runs/1

<!-- issue-deck-source:claude-review-develop -->`);
    expect(resolveMergeCheckReasons(labels(), [fallback]).items).toEqual([
      "自動マージ（auto-merge）の有効化に失敗したため、ユーザーのマージ操作が必要です",
      "GitHub Actionsワークフローの変更 (.github/workflows/**)",
    ]);
  });

  it("判定が下る前にマージされた場合の定型文（事後の確認）からも理由を取り出す（#1968）", () => {
    const merged = comment(`⚠️ このPRは自動マージ可否の判定が終わる前にdevelopへマージされています。以下の理由により、事後の確認が必要です。

- DBマイグレーションの変更 (prisma/migrations/**)

<!-- issue-deck-source:claude-review-develop -->`);
    expect(resolveMergeCheckReasons(labels(), [merged]).items).toEqual([
      "DBマイグレーションの変更 (prisma/migrations/**)",
    ]);
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
