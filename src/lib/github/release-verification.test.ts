import { describe, expect, it } from "vitest";

import { parseReleaseVerification } from "@/lib/github/release-verification";

/**
 * `reusable-release-develop-to-main.yml`の「対象issueの検証結果を集計する」ステップが
 * 実際に書く形。ここを直すときはワークフロー側も揃える。
 */
const RELEASE_BODY = `developの内容をv4.49.0としてmainへリリースします。

## 対象issue
- #2441 レビューのゲートを直す
- #2438 更新履歴の文言を短くする

## コードレビューの検証結果

developへ入れる前に各PRで行った自動レビューの判定です（#2448）。

| Issue | PR | 自動レビュー | 機械的リスク判定 |
| --- | --- | --- | --- |
| #2441 | #2446 | ✅ 問題なし | 該当なし |
| #2443 | #2445 | ⚠️ 要確認 | ⚠️ 該当あり |
| #2438 | #2450 | — 実施なし | 該当なし |
| #2432 | — | ? 記録なし | ? 記録なし |

<details>
<summary>#2441 の自動レビュー（✅ 問題なし）</summary>

<!-- issue-deck-review-detail:start issue=2441 -->

> ## 総評
>
> LGTM。ゲートの条件は仕様どおりです。
>
> | 観点 | 結果 |
> | --- | --- |
> | テスト | 追加あり |

[元のレビューコメントを開く](https://github.com/guchi-apps/issue-deck/pull/2446#issuecomment-1)
<!-- issue-deck-review-detail:end -->

</details>

<details>
<summary>#2443 の自動レビュー（⚠️ 要確認）</summary>

<!-- issue-deck-review-detail:start issue=2443 -->

> 要確認。GitHub Actionsの設定に触れています。
>
> （長いため以降を省略しました。全文は元のレビューコメントで読めます）
<!-- issue-deck-review-detail:end -->

</details>

## 注意点
- このPRはGitHub Actionsが自動作成しました
`;

describe("parseReleaseVerification", () => {
  it("見出しの下の表を読み、判定ごとに数える", () => {
    const parsed = parseReleaseVerification(RELEASE_BODY);

    expect(parsed).not.toBeNull();
    expect(parsed?.rows).toHaveLength(4);
    expect(parsed?.tally).toEqual({
      total: 4,
      ok: 1,
      needsCheck: 1,
      changesRequested: 0,
      skipped: 1,
      unknown: 1,
    });
  });

  it("Issue番号・PR番号・判定・文言を取り出す", () => {
    const rows = parseReleaseVerification(RELEASE_BODY)?.rows ?? [];

    expect(rows[0]).toMatchObject({
      issueNumber: 2441,
      // `## 対象issue`に載っているものはタイトルも添える
      issueTitle: "レビューのゲートを直す",
      pullRequestNumber: 2446,
      reviewKind: "ok",
      reviewLabel: "問題なし",
      riskKind: "none",
      riskLabel: "該当なし",
    });
    // 対象issue一覧に載っていない行はタイトルがnullになる（表と一覧は別々に作られる）
    expect(rows[1]).toMatchObject({
      issueNumber: 2443,
      issueTitle: null,
      reviewKind: "needs-check",
      riskKind: "hit",
      riskLabel: "該当あり",
    });
    expect(rows[2]).toMatchObject({
      reviewKind: "skipped",
      reviewLabel: "実施なし",
    });
  });

  it("PRが見つからなかった行はpullRequestNumberをnullにし、行自体は残す", () => {
    const rows = parseReleaseVerification(RELEASE_BODY)?.rows ?? [];

    // 記録が無いことも読めなければ意味がないので、行ごと落とさない
    expect(rows[3]).toMatchObject({
      issueNumber: 2432,
      pullRequestNumber: null,
      reviewKind: "unknown",
      reviewLabel: "記録なし",
      riskKind: "unknown",
    });
  });

  it("折りたたみに入っているレビュー本文を、Issue番号ごとに行へ付ける（#2488）", () => {
    const rows = parseReleaseVerification(RELEASE_BODY)?.rows ?? [];

    expect(rows[0].reviewBody).toContain("LGTM。ゲートの条件は仕様どおりです。");
    // 見出しも表も本文の一部としてそのまま持つ（画面はMarkdownとして描く）
    // ワークフローは引用（`> `）にして差し込む。素の見出し・表のままだと、リリースPR本文を
    // 見出しで区切って読む側がレビューの書きぶりで変わってしまうため
    expect(rows[0].reviewBody).toContain("> ## 総評");
    expect(rows[0].reviewBody).toContain("> | テスト | 追加あり |");
    expect(rows[0].reviewBody).toContain(
      "[元のレビューコメントを開く](https://github.com/guchi-apps/issue-deck/pull/2446#issuecomment-1)",
    );
    // 打ち切られた回もそのまま出す（省略した旨はワークフローが本文へ書いている）
    expect(rows[1].reviewBody).toContain("（長いため以降を省略しました。");
    // レビューが走らなかった・記録が無い行は本文を持たない
    expect(rows[2].reviewBody).toBeNull();
    expect(rows[3].reviewBody).toBeNull();
  });

  it("レビュー本文の中の表を、検証結果の行として読み込まない（#2488）", () => {
    // 折りたたみの開始マーカーで表の読み取りを打ち切る。打ち切らないと、本文に含まれる
    // `| #99 | ... |`のような行まで検証結果の行になってしまう
    const body = `## コードレビューの検証結果

| Issue | PR | 自動レビュー | 機械的リスク判定 |
| --- | --- | --- | --- |
| #1 | #2 | ✅ 問題なし | 該当なし |

<details>
<summary>#1 の自動レビュー（✅ 問題なし）</summary>

<!-- issue-deck-review-detail:start issue=1 -->

| #99 | #98 | ✅ 問題なし | 該当なし |
<!-- issue-deck-review-detail:end -->

</details>
`;

    const parsed = parseReleaseVerification(body);
    expect(parsed?.rows.map((row) => row.issueNumber)).toEqual([1]);
    expect(parsed?.rows[0].reviewBody).toBe("| #99 | #98 | ✅ 問題なし | 該当なし |");
  });

  it("次の見出しより後の表は読まない", () => {
    const body = `## コードレビューの検証結果

| Issue | PR | 自動レビュー | 機械的リスク判定 |
| --- | --- | --- | --- |
| #1 | #2 | ✅ 問題なし | 該当なし |

## 別の表
| Issue | PR | 自動レビュー | 機械的リスク判定 |
| #99 | #98 | ✅ 問題なし | 該当なし |
`;

    expect(parseReleaseVerification(body)?.rows.map((row) => row.issueNumber)).toEqual([1]);
  });

  it("見出しが無い・表が空・本文が無い場合はnullを返す", () => {
    expect(parseReleaseVerification("## 対象issue\n- #1 なにか")).toBeNull();
    expect(parseReleaseVerification("## コードレビューの検証結果\n\n（集計できませんでした）")).toBeNull();
    expect(parseReleaseVerification(null)).toBeNull();
    expect(parseReleaseVerification("")).toBeNull();
  });

  it("CRLFの本文でも読める", () => {
    const parsed = parseReleaseVerification(RELEASE_BODY.replace(/\n/g, "\r\n"));

    expect(parsed?.rows).toHaveLength(4);
  });
});
