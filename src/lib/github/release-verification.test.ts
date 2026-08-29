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
| #2438 | #2450 | — 実施なし（低リスク・小規模） | 該当なし |
| #2432 | — | ? 記録なし | ? 記録なし |

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

    expect(rows[0]).toEqual({
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
      reviewLabel: "実施なし（低リスク・小規模）",
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
