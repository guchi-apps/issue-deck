// `.github/workflows/reusable-release-develop-to-main.yml`の
// 「リリース対象のプルリクエストとissueを特定する」ステップを、実物のgitリポジトリと
// GitHub CLIのスタブに対して実行する（#2774）。
//
// このステップが作る2つの一覧は、リリースPR本文の`## 対象プルリクエスト`・`## 対象issue`に
// なり、後者は`reusable-issue-labels.yml`の`main-pr-merged`が読んでIssueをDoneにしてclose
// する。**判定はすべて`run:`のbashにあり、間違えるとIssueが取り残される**（#2715で実際に
// 起きた）。`reusable-issue-labels.test.mjs`と同じやり方でYAMLから`run:`本文を取り出し、
// 使い捨てのリポジトリの上でそのまま走らせる。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/**
 * `gh issue view <番号> --json number,title,state`だけを返すスタブ。
 * 該当が無ければ何も出さずに終了コード1（実物と同じく「存在しないissue」の扱い）。
 */
const STUB_GH = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  var="STUB_ISSUE_\${3}"
  value="\${!var:-}"
  if [ -z "$value" ]; then exit 1; fi
  printf '%s' "$value"
  exit 0
fi
exit 1
`;

let workDir;
let gitDir;

function git(...args) {
  return execFileSync("git", args, {
    cwd: gitDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

let fileSeq = 0;

/** 新しいファイルを1つ足してコミットする（ブランチ同士が衝突しないよう毎回別ファイルにする） */
function commit(message) {
  fileSeq += 1;
  writeFileSync(path.join(gitDir, `file-${fileSeq}.txt`), `${message}\n`);
  git("add", "-A");
  git("commit", "-m", message);
}

/** `<branch>`を現在のブランチへPRのマージコミットとして取り込む */
function mergePullRequest(branch, pullRequestNumber, title) {
  git(
    "merge",
    "--no-ff",
    branch,
    "-m",
    `Merge pull request #${pullRequestNumber} from guchi-apps/${branch}`,
    "-m",
    title,
  );
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "release-target-list-"));
  gitDir = path.join(workDir, "repo");
  const ghPath = path.join(workDir, "gh");
  writeFileSync(ghPath, STUB_GH);
  chmodSync(ghPath, 0o755);

  execFileSync("git", ["init", "-q", "-b", "develop", gitDir]);
  fileSeq = 0;
  commit("初期コミット");
  // mainは初期コミットのまま。リリース範囲は origin/main..origin/develop になる
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** developの先端をorigin/developとして固定し、ステップを実行する */
function runStep({ issues = {}, needMainPr = false, pushedSha = "" } = {}) {
  git("update-ref", "refs/remotes/origin/develop", "develop");

  const script = extractRunScript("リリース対象のプルリクエストとissueを特定する").replaceAll(
    "/tmp/",
    `${workDir}/`,
  );
  const githubOutput = path.join(workDir, "github-output.txt");
  writeFileSync(githubOutput, "");

  const env = {
    ...process.env,
    PATH: `${workDir}:${process.env.PATH}`,
    GITHUB_OUTPUT: githubOutput,
    GH_REPO: "guchi-apps/asset-manager",
    NEED_MAIN_PR: needMainPr ? "true" : "false",
    DEV_VERSION: "1.2.0",
    VERSION_FILE: "package.json",
    VERSION_QUERY: ".version",
    EVENT_NAME: needMainPr ? "push" : "workflow_dispatch",
    PUSHED_SHA: pushedSha,
    // フォールバック（issue-deckへの問い合わせ）へ落ちたことを検知しやすくするため未設定にする
    APP_BASE_URL: "",
    PROGRESS_REPORT_SECRET: "",
  };
  for (const [number, json] of Object.entries(issues)) {
    env[`STUB_ISSUE_${number}`] = JSON.stringify(json);
  }

  const stdout = execFileSync("bash", ["-e", "-c", script], {
    cwd: gitDir,
    env,
    encoding: "utf8",
  });

  const read = (name) => {
    try {
      return readFileSync(path.join(workDir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    stdout,
    prLines: read("release-pr-lines.txt"),
    issueLines: read("release-issue-lines.txt"),
    output: readFileSync(githubOutput, "utf8"),
  };
}

function openIssue(number, title) {
  return { number, title, state: "OPEN" };
}

describe("リリース対象のプルリクエストとissueを特定する", () => {
  it("マージコミットからプルリクエストを拾い、ブランチ名から対応issueを導く", () => {
    git("checkout", "-q", "-b", "issue-456");
    commit("バッジを直す");
    git("checkout", "-q", "develop");
    mergePullRequest("issue-456", 123, "進捗バッジで活動と経過時間だけを出す");

    git("checkout", "-q", "-b", "issue-457");
    commit("重複を除く");
    git("checkout", "-q", "develop");
    mergePullRequest("issue-457", 124, "家計の取り込みで重複した明細を除く");

    const result = runStep({
      issues: {
        456: openIssue(456, "進捗バッジの表示を整理する"),
        457: openIssue(457, "家計の取り込みで明細が重複する"),
      },
    });

    expect(result.prLines).toBe(
      [
        "- #123 進捗バッジで活動と経過時間だけを出す（Issue #456）",
        "- #124 家計の取り込みで重複した明細を除く（Issue #457）",
        "",
      ].join("\n"),
    );
    // 書式は#2774以前と同じ`- #<番号> <タイトル>`。`main-pr-merged`がこの形で読む
    expect(result.issueLines).toBe(
      ["- #456 進捗バッジの表示を整理する", "- #457 家計の取り込みで明細が重複する", ""].join("\n"),
    );
    // issue-deckへ問い合わせずにここまで作れている
    expect(result.stdout).not.toContain("issue-deckへ問い合わせます");
  });

  it("バージョンバンプのPRはissueではなくバンプとして印を付ける", () => {
    git("checkout", "-q", "-b", "release/v1.2.0");
    commit("バージョンを1.2.0へ上げる");
    git("checkout", "-q", "develop");
    mergePullRequest("release/v1.2.0", 130, "v1.2.0をリリースする");

    const result = runStep();

    expect(result.prLines).toBe("- #130 v1.2.0をリリースする（バージョンバンプ）\n");
    expect(result.issueLines).toBe("（プルリクエストに対応するopenなissueはありませんでした）\n");
  });

  it("作業ブランチの中で取り込んだPRは数えない（--first-parent）", () => {
    git("checkout", "-q", "-b", "issue-459");
    commit("先に直す");
    git("checkout", "-q", "develop");
    git("checkout", "-q", "-b", "issue-458");
    commit("あとで直す");
    // 作業ブランチ側で別のPRブランチを取り込む。developの本流ではない
    mergePullRequest("issue-459", 200, "先の変更");
    git("checkout", "-q", "develop");
    mergePullRequest("issue-458", 201, "あとの変更");

    const result = runStep({ issues: { 458: openIssue(458, "あとの依頼") } });

    expect(result.prLines).toBe("- #201 あとの変更（Issue #458）\n");
    expect(result.issueLines).toBe("- #458 あとの依頼\n");
  });

  it("closedなissueは対象issueに載せない", () => {
    git("checkout", "-q", "-b", "issue-460");
    commit("直す");
    git("checkout", "-q", "develop");
    mergePullRequest("issue-460", 140, "直した");

    const result = runStep({ issues: { 460: { number: 460, title: "済み", state: "CLOSED" } } });

    expect(result.prLines).toBe("- #140 直した（Issue #460）\n");
    expect(result.issueLines).toBe("（プルリクエストに対応するopenなissueはありませんでした）\n");
  });

  it("squashマージ運用（マージコミットが無い）では件名の(#番号)から拾う", () => {
    commit("資産推移グラフの軸ラベルの重なりを直す (#151)");
    commit("家計の取り込みで重複した明細を除く (#152)");

    const result = runStep();

    expect(result.prLines).toBe(
      [
        "- #151 資産推移グラフの軸ラベルの重なりを直す",
        "- #152 家計の取り込みで重複した明細を除く",
        "",
      ].join("\n"),
    );
    // 対応issueまでは辿れないが、issue-deckへ問い合わせる経路には落ちない
    expect(result.issueLines).toBe("（プルリクエストに対応するopenなissueはありませんでした）\n");
  });

  it("develop→mainのrunでは凍結点を出力し、その範囲だけを対象にする", () => {
    git("checkout", "-q", "-b", "issue-461");
    commit("リリースに入る変更");
    git("checkout", "-q", "develop");
    mergePullRequest("issue-461", 160, "リリースに入る変更");

    // バンプPR（release/v1.2.0）をdevelopへマージしたpushを再現する。
    // 凍結点はそのマージコミットの第2親＝バンプPRの先端。
    git("checkout", "-q", "-b", "release/v1.2.0");
    writeFileSync(path.join(gitDir, "package.json"), '{ "version": "1.2.0" }\n');
    git("add", "-A");
    git("commit", "-m", "バージョンを1.2.0へ上げる");
    git("checkout", "-q", "develop");
    mergePullRequest("release/v1.2.0", 161, "v1.2.0をリリースする");
    const bumpMerge = git("rev-parse", "HEAD").trim();
    const freezeSha = git("rev-parse", "HEAD^2").trim();

    // 凍結後にdevelopへ入った変更。このリリースには含めない（#2117）
    git("checkout", "-q", "-b", "issue-462");
    commit("次のリリースへ回る変更");
    git("checkout", "-q", "develop");
    mergePullRequest("issue-462", 162, "次のリリースへ回る変更");

    const result = runStep({
      needMainPr: true,
      pushedSha: bumpMerge,
      issues: {
        461: openIssue(461, "リリースに入る依頼"),
        462: openIssue(462, "次のリリースへ回る依頼"),
      },
    });

    expect(result.output).toContain(`freeze_sha=${freezeSha}`);
    expect(result.prLines).toBe("- #160 リリースに入る変更（Issue #461）\n");
    expect(result.issueLines).toBe("- #461 リリースに入る依頼\n");
    expect(result.prLines).not.toContain("#162");
  });
});
