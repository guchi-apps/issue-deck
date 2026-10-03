// `.github/workflows/reusable-release-develop-to-main.yml`の「対象issueの検証結果を集計する」
// ステップを、GitHub CLIをスタブに差し替えて実行する（#2488）。
//
// このステップが作る表と折りたたみは、develop→mainのマージを人が判断するときの唯一の材料で
// ありながら、判定はすべて`run:`のbashにある。**`continue-on-error: true`なので、壊れても
// リリースは通り、リリースPRから記録が黙って消えるだけ**になる。実際に走らせないと確かめられ
// ないため、`reusable-issue-labels.test.mjs`と同じやり方でYAMLから`run:`本文を取り出して実行する。
//
// スクリプトが使う`/tmp`の固定パスは、テスト実行が互いに踏まないよう一時ディレクトリへ
// 置き換える（置き換えるのはパスだけで、判定のロジックはYAMLのものをそのまま走らせる）。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPullRequestFixIssueDraft } from "@/lib/github/pull-request-fix-issue";
import {
  buildReleaseVerificationFixIssueDraft,
  parseReleaseVerification,
} from "@/lib/github/release-verification";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/reusable-release-develop-to-main.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

/** ステップ名から`run: |`の本文を取り出す（`reusable-issue-labels.test.mjs`と同じ最小実装） */
function extractRunScript(stepName) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`ステップが見つかりません: ${stepName}`);

  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  if (runIndex < 0) throw new Error(`run: が見つかりません: ${stepName}`);

  const body = [];
  const indent = lines[runIndex].search(/\S/) + 2;
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// `gh pr list ... --json number,body,comments --jq '.[0] // empty'`の結果と、
// `gh issue view <番号> --json body --jq '.body // ""'`の結果（#3634）だけを返す。
// `--jq`はgh側で適用されるので、スタブはPRのオブジェクト・Issueの本文をそのまま出す。
const STUB_GH = `#!/usr/bin/env bash
set -u
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  var="STUB_ISSUE_$3"
  printf '%s' "\${!var:-}"
  exit 0
fi
# 確認済みの記録（#3739）。gh api --paginate repos/<repo>/issues/<PR>/comments --jq ... の結果は、
# ワークフローの--jq（投稿者をissue-deck[bot]に絞る）が適用済みの「本文の配列」なので、スタブは
# その配列をそのまま出す。**投稿者の絞り込みそのものはghが行うため、ここでは確かめられない**
if [ "$1" = "api" ]; then
  for arg in "$@"; do
    case "$arg" in
      repos/*/issues/*/comments)
        n="\${arg#repos/*/issues/}"; n="\${n%/comments}"
        var="STUB_ACK_$n"
        printf '%s' "\${!var:-[]}"
        exit 0
        ;;
    esac
  done
fi
head=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--head" ]; then head="$2"; fi
  shift
done
var="STUB_PR_\${head#issue-}"
printf '%s' "\${!var:-}"
`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "release-verification-"));
  const ghPath = path.join(workDir, "gh");
  writeFileSync(ghPath, STUB_GH);
  chmodSync(ghPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 集計ステップを走らせ、書き出された`## コードレビューの検証結果`の節を返す。
 *
 * @param issueLines `## 対象issue`の行（`- #<番号> <タイトル>`）
 * @param prs Issue番号 → `gh pr list`が返すPRのJSON
 * @param issueBodies Issue番号 → `gh issue view`が返す本文（#3634）
 */
function runAggregation(issueLines, prs, issueBodies = {}, ackComments = {}) {
  writeFileSync(path.join(workDir, "release-issue-lines.txt"), `${issueLines.join("\n")}\n`);

  const script = extractRunScript("対象issueの検証結果を集計する").replaceAll(
    "/tmp/",
    `${workDir}/`,
  );
  const env = { ...process.env, PATH: `${workDir}:${process.env.PATH}`, GH_REPO: "guchi-apps/issue-deck" };
  for (const [prNumber, bodies] of Object.entries(ackComments)) {
    env[`STUB_ACK_${prNumber}`] = JSON.stringify(bodies);
  }
  for (const [number, json] of Object.entries(prs)) {
    env[`STUB_PR_${number}`] = JSON.stringify(json);
  }
  for (const [number, body] of Object.entries(issueBodies)) {
    env[`STUB_ISSUE_${number}`] = body;
  }

  execFileSync("bash", ["-e", "-c", script], { env, encoding: "utf8" });
  return readFileSync(path.join(workDir, "release-verification.md"), "utf8");
}

/** レビューが投稿するPRコメント。末尾の判定マーカーが目印（#2448） */
function reviewComment(body, verdict = "lgtm") {
  return {
    url: "https://github.com/guchi-apps/issue-deck/pull/2446#issuecomment-1",
    body: `${body}\n\n<!-- issue-deck-review-verdict:${verdict} sha=abc123 -->`,
  };
}

describe("対象issueの検証結果を集計する", () => {
  it("判定の表と、レビューコメント本文の折りたたみを書く", () => {
    const out = runAggregation(
      ["- #2441 レビューのゲートを直す"],
      {
        2441: {
          number: 2446,
          body: "実装しました。\n\n<!-- issue-deck-verification:start review=lgtm risk=none -->\n## 検証結果\n<!-- issue-deck-verification:end -->",
          comments: [
            { url: "https://example.com/other", body: "自動修復のコメント" },
            reviewComment("## 総評\n\nLGTM。仕様どおりです。"),
          ],
        },
      },
    );

    expect(out).toContain("| #2441 | #2446 | ✅ 問題なし | 該当なし |");
    // 画面（src/lib/github/release-verification.ts）が読むマーカー
    expect(out).toContain("<!-- issue-deck-review-detail:start issue=2441 -->");
    expect(out).toContain("<!-- issue-deck-review-detail:end -->");
    expect(out).toContain("LGTM。仕様どおりです。");
    expect(out).toContain(
      "[元のレビューコメントを開く](https://github.com/guchi-apps/issue-deck/pull/2446#issuecomment-1)",
    );
    // 判定マーカーの行は読み手に見えないので落とす
    expect(out).not.toContain("issue-deck-review-verdict");
    // 表と折りたたみのあいだに空行が要る（無いとGitHubが表を閉じない）
    expect(out).toMatch(/該当なし \|\n\n<details>/);
    // **本文は引用にして差し込む。** 素の見出しのまま埋めると、リリースPR本文を見出しで
    // 区切って読む側（`## 対象issue`の切り出しなど）がレビューの書きぶりで変わる
    expect(out).toContain("> ## 総評");
    const detail = out.slice(out.indexOf("<!-- issue-deck-review-detail:start"));
    expect(detail.split("\n").filter((line) => line.startsWith("## "))).toEqual([]);
  });

  it("Codexの要修正を集計し、後から届いたClaudeのLGTMで指摘を隠さない", () => {
    const out = runAggregation(["- #3917 Codexレビュー"], {
      3917: {
        number: 3927,
        headRefOid: "abc123",
        body: "<!-- issue-deck-verification:start review=changes-requested risk=none -->\n<!-- issue-deck-verification:end -->",
        comments: [
          {
            url: "https://example.com/codex",
            body: "Codexの要修正指摘\n\n<!-- issue-deck-codex-review-verdict:changes-requested sha=abc123 -->",
          },
          reviewComment("ClaudeはLGTM。"),
        ],
      },
    });

    expect(out).toContain("| #3917 | #3927 | ❌ 要修正 | 該当なし |");
    expect(out).toContain("Codexの要修正指摘");
    expect(out).not.toContain("ClaudeはLGTM。");
    expect(out).toContain("[元のレビューコメントを開く](https://example.com/codex)");
  });

  it("Claudeが同じSHAで撤回した古い指摘を選ばない", () => {
    const out = runAggregation(["- #3917 再レビュー"], {
      3917: {
        number: 3927,
        headRefOid: "abc123",
        body: "<!-- issue-deck-verification:start review=changes-requested risk=none -->\n<!-- issue-deck-verification:end -->",
        comments: [
          {
            url: "https://example.com/codex",
            body: "Codexの現在の指摘B\n\n<!-- issue-deck-codex-review-verdict:changes-requested sha=abc123 -->",
          },
          reviewComment("Claudeの撤回済み指摘A", "changes-requested"),
          reviewComment("Claudeは再レビューでLGTM", "lgtm"),
        ],
      },
    });

    expect(out).toContain("Codexの現在の指摘B");
    expect(out).not.toContain("Claudeの撤回済み指摘A");
  });

  it("ワークフローが転記したレビュー結果も拾う（#2488）", () => {
    // 判定マーカーが無くても、転記の印が付いたコメントは結果として載せる
    const out = runAggregation(["- #2441 転記された結果"], {
      2441: {
        number: 2446,
        body: "",
        comments: [
          {
            url: "https://github.com/guchi-apps/issue-deck/pull/2446#issuecomment-9",
            body: "🤖 **自動レビューの結果**\n\n要確認です。\n\n<!-- issue-deck-review-report sha=abc123 -->",
          },
        ],
      },
    });

    expect(out).toContain("<!-- issue-deck-review-detail:start issue=2441 -->");
    expect(out).toContain("> 要確認です。");
  });

  it("長いレビューコメントは打ち切り、元コメントへ誘導する", () => {
    const long = Array.from({ length: 200 }, (_, index) => `${index}行目の指摘`).join("\n");
    const out = runAggregation(["- #2441 長いレビュー"], {
      2441: { number: 2446, body: "", comments: [reviewComment(long)] },
    });

    expect(out).toContain("0行目の指摘");
    expect(out).toContain("（長いため以降を省略しました。全文は元のレビューコメントで読めます）");
    expect(out).not.toContain("199行目の指摘");
    // PR本文の上限（65,536文字）に対して十分小さいこと
    expect(out.length).toBeLessThan(8000);
  });

  it("レビューコメントが無いPR・PRが見つからないIssueでも、表の行は残す", () => {
    const out = runAggregation(["- #2441 ローカルでマージした", "- #2432 PRが無い"], {
      2441: { number: 2446, body: "", comments: [{ url: "https://example.com", body: "ふつうのコメント" }] },
    });

    expect(out).toContain("| #2441 | #2446 | ? 記録なし | ? 記録なし |");
    expect(out).toContain("| #2432 | — | ? 記録なし | ? 記録なし |");
    expect(out).not.toContain("<details>");
  });

  // 書く側と読む側の突き合わせ。`check-review-verdict-marker.sh`はマーカーの文字列しか
  // 見ないので、実際に書いた本文を画面のパーサーへ通すところまでをここで確かめる。
  it("書き出した節を、画面のパーサーがそのまま読める", () => {
    const out = runAggregation(["- #2441 レビューのゲートを直す"], {
      2441: {
        number: 2446,
        body: "<!-- issue-deck-verification:start review=needs-check risk=hit -->\n<!-- issue-deck-verification:end -->",
        comments: [reviewComment("要確認。`.github/workflows/`に触れています。", "needs-check")],
      },
    });

    const parsed = parseReleaseVerification(`## 対象issue\n- #2441 レビューのゲートを直す\n\n${out}`);

    expect(parsed?.rows).toHaveLength(1);
    expect(parsed?.rows[0]).toMatchObject({
      issueNumber: 2441,
      issueTitle: "レビューのゲートを直す",
      pullRequestNumber: 2446,
      reviewKind: "needs-check",
      riskKind: "hit",
    });
    expect(parsed?.rows[0].reviewBody).toContain("要確認。");
  });

  describe("修正Issueで直したPR（#3634）", () => {
    const changesRequested = {
      number: 2446,
      body: "<!-- issue-deck-verification:start review=changes-requested risk=none -->\n<!-- issue-deck-verification:end -->",
      comments: [reviewComment("境界値の扱いが誤っています。", "changes-requested")],
    };
    const lgtm = {
      number: 2460,
      body: "<!-- issue-deck-verification:start review=lgtm risk=none -->\n<!-- issue-deck-verification:end -->",
      comments: [],
    };
    // 本文は画面が実際に作る下書きから作る。文言がずれたら、ここで落ちる
    const releaseFixBody = buildReleaseVerificationFixIssueDraft({
      row: {
        issueNumber: 2441,
        issueTitle: "レビューのゲートを直す",
        pullRequestNumber: 2446,
        reviewKind: "changes-requested",
        reviewLabel: "要修正",
        riskKind: "none",
        riskLabel: "該当なし",
        reviewBody: null,
      },
      repositoryFullName: "guchi-apps/issue-deck",
      releasePullRequestNumber: 2450,
    }).body;
    const pullRequestFixBody = buildPullRequestFixIssueDraft({
      pullRequest: {
        repositoryFullName: "guchi-apps/issue-deck",
        number: 2446,
        title: "レビューのゲートを直す",
        baseRef: "develop",
        headRef: "issue-2441",
        merged: true,
        state: "closed",
        linkedIssueNumbers: [2441],
        reviewVerdict: null,
      },
      review: null,
      openChangeRequests: [],
    }).body;

    it.each([
      ["リリースの検証結果から起票した修正Issue", releaseFixBody],
      ["PR詳細から起票した修正Issue", pullRequestFixBody],
    ])("%sが同じリリースに入っていれば、元PRの行を修正済みにする", (_, fixBody) => {
      const out = runAggregation(
        ["- #2455 レビューのゲートを直す の修正（レビュー指摘）", "- #2441 レビューのゲートを直す"],
        { 2441: changesRequested, 2455: lgtm },
        { 2455: fixBody },
      );

      expect(out).toContain("| #2441 | #2446 | ✅ #2455 で修正済み（元の判定: 要修正） | 該当なし |");
      expect(out).toContain("| #2455 | #2460 | ✅ 問題なし | 該当なし |");

      // 画面では問題なしとして数え、マージ確認で止めない
      const parsed = parseReleaseVerification(out);
      expect(parsed?.tally).toMatchObject({ total: 2, ok: 2, changesRequested: 0 });
      expect(parsed?.rows.find((row) => row.issueNumber === 2441)).toMatchObject({
        reviewKind: "ok",
        reviewLabel: "#2455 で修正済み（元の判定: 要修正）",
      });
      // 元の指摘は折りたたみで読めるまま残す
      expect(out).toContain("> 境界値の扱いが誤っています。");
    });

    it("修正Issueがリリースに入っていなければ、要修正のまま残す", () => {
      const out = runAggregation(["- #2441 レビューのゲートを直す"], { 2441: changesRequested });

      expect(out).toContain("| #2441 | #2446 | ❌ 要修正 | 該当なし |");
    });

    it("番号の前方一致で別のPRを修正済みにしない", () => {
      const out = runAggregation(
        ["- #2455 別件の修正", "- #2441 レビューのゲートを直す"],
        { 2441: changesRequested, 2455: lgtm },
        { 2455: "- 対象PR: #24460（develop ← issue-1・マージ済み）" },
      );

      expect(out).toContain("| #2441 | #2446 | ❌ 要修正 | 該当なし |");
    });
  });

  it("対象issueが1件も無ければ、表そのものを作らない", () => {
    const out = runAggregation(["（issue-deckへ問い合わせできませんでした）"], {});

    expect(out).toBe("");
  });
});

describe("確認済みの記録を読む（#3739）", () => {
  const pr = (verdict) => ({
    number: 2446,
    body: `<!-- issue-deck-verification:start review=${verdict} risk=none -->\n## 検証結果\n<!-- issue-deck-verification:end -->`,
    comments: [reviewComment("## 総評\n\n気になる点あり。", verdict)],
  });
  const ack = (sha, by = "guchi") => `<!-- issue-deck-review-ack sha=${sha} by=${by} -->\n対応しない`;
  const revoke = (sha) => `<!-- issue-deck-review-ack-revoke sha=${sha} -->`;
  const lines = ["- #2441 レビューのゲートを直す"];

  it("レビューのshaと一致する記録があれば、確認済みにする", () => {
    const out = runAggregation(lines, { 2441: pr("needs-check") }, {}, { 2446: [ack("abc123")] });
    expect(out).toContain("| #2441 | #2446 | ✅ 確認済み（元の判定: 要確認、記録: guchi） | 該当なし |");
    // 画面が読み戻せる
    const row = parseReleaseVerification(out)?.rows[0];
    expect(row?.reviewKind).toBe("ok");
    expect(row?.acknowledgement).toEqual({ verdict: "needs-check", recordedBy: "guchi" });
  });

  it("要修正も確認済みにできる", () => {
    const out = runAggregation(lines, { 2441: pr("changes-requested") }, {}, { 2446: [ack("abc123")] });
    expect(out).toContain("✅ 確認済み（元の判定: 要修正、記録: guchi）");
  });

  it("別のコミットへの記録・取り消された記録・記録なしは、元の判定のまま", () => {
    const stale = runAggregation(lines, { 2441: pr("needs-check") }, {}, { 2446: [ack("def456")] });
    expect(stale).toContain("| #2441 | #2446 | ⚠️ 要確認 | 該当なし |");
    const revoked = runAggregation(lines, { 2441: pr("needs-check") }, {}, { 2446: [ack("abc123"), revoke("abc123")] });
    expect(revoked).toContain("| #2441 | #2446 | ⚠️ 要確認 | 該当なし |");
    const none = runAggregation(lines, { 2441: pr("needs-check") });
    expect(none).toContain("| #2441 | #2446 | ⚠️ 要確認 | 該当なし |");
  });

  it("問題なしの行は書き換えない", () => {
    const out = runAggregation(lines, { 2441: pr("lgtm") }, {}, { 2446: [ack("abc123")] });
    expect(out).toContain("| #2441 | #2446 | ✅ 問題なし | 該当なし |");
  });
});
