// `.github/workflows/reusable-release-develop-to-main.yml`の「リリースの作り直し」（#3014）を、
// 実物のgitリポジトリとGitHub CLIのスタブに対して実行する。
//
// リリースPR（`release-main/vX.Y.Z`）を閉じて手動で起動し直したとき、バンプPRのマージ以降に
// developへ変更が入っていれば、前回のバンプを取り消してバンプから作り直す。判定も取り消しも
// `run:`のbashにあり、間違えると「同じ版のまま更新履歴が古いリリースPR」か「pushトリガーが
// 発火せずリリースPRが作られない」かのどちらかで黙って止まる。`reusable-release-target-list.test.mjs`
// と同じやり方でYAMLから`run:`本文を取り出し、使い捨てのリポジトリの上でそのまま走らせる。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowYaml = readFileSync(
  path.join(repoRoot, ".github/workflows/reusable-release-develop-to-main.yml"),
  "utf8",
);

/** ステップ名から`run: |`の本文を取り出す（`reusable-release-target-list.test.mjs`と同じ最小実装） */
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

// `gh pr list`は空配列の結果（`--jq`適用後の空文字）を返し、`gh pr create`・`gh pr merge`は
// 呼ばれた引数を記録するだけにする。
const STUB_GH = `#!/usr/bin/env bash
set -u
echo "$*" >> "$STUB_GH_LOG"
exit 0
`;

let workDir;
let gitDir;

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(...args) {
  return execFileSync("git", args, { cwd: gitDir, encoding: "utf8", env: { ...process.env, ...gitEnv } });
}

function writeVersion(version) {
  writeFileSync(path.join(gitDir, "package.json"), `${JSON.stringify({ name: "app", version }, null, 2)}\n`);
}

function readVersion() {
  return JSON.parse(readFileSync(path.join(gitDir, "package.json"), "utf8")).version;
}

let fileSeq = 0;

/** `<branch>`をdevelopから切り、1コミット足してPRのマージコミットとしてdevelopへ取り込む */
function mergePullRequest(branch, pullRequestNumber, change = () => {}) {
  git("checkout", "-q", "-b", branch, "develop");
  fileSeq += 1;
  writeFileSync(path.join(gitDir, `file-${fileSeq}.txt`), `${branch}\n`);
  change();
  git("add", "-A");
  git("commit", "-q", "-m", branch);
  git("checkout", "-q", "develop");
  git("merge", "-q", "--no-ff", branch, "-m", `Merge pull request #${pullRequestNumber} from guchi-apps/${branch}`);
  return git("rev-parse", "HEAD").trim();
}

/** バンプPR（版の書き換え＋更新履歴への追記）をdevelopへ取り込む */
function mergeBump(version, pullRequestNumber) {
  return mergePullRequest(`release/v${version}`, pullRequestNumber, () => {
    writeVersion(version);
    writeFileSync(path.join(gitDir, "CHANGELOG.md"), `# v${version}\n\n# v1.0.0\n`);
  });
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "release-rebuild-"));
  gitDir = path.join(workDir, "repo");
  const ghPath = path.join(workDir, "gh");
  writeFileSync(ghPath, STUB_GH);
  chmodSync(ghPath, 0o755);
  writeFileSync(path.join(workDir, "gh.log"), "");

  execFileSync("git", ["init", "-q", "--bare", path.join(workDir, "remote.git")]);
  execFileSync("git", ["init", "-q", "-b", "develop", gitDir]);
  git("remote", "add", "origin", path.join(workDir, "remote.git"));
  fileSeq = 0;
  writeVersion("1.0.0");
  writeFileSync(path.join(gitDir, "CHANGELOG.md"), "# v1.0.0\n");
  git("add", "-A");
  git("commit", "-q", "-m", "初期コミット");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function baseEnv() {
  const githubOutput = path.join(workDir, "github-output.txt");
  writeFileSync(githubOutput, "");
  return {
    githubOutput,
    env: {
      ...process.env,
      ...gitEnv,
      PATH: `${workDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: githubOutput,
      GH_REPO: "guchi-apps/app",
      STUB_GH_LOG: path.join(workDir, "gh.log"),
      VERSION_FILE: "package.json",
      VERSION_QUERY: ".version",
    },
  };
}

function readOutputs(githubOutput) {
  return Object.fromEntries(
    readFileSync(githubOutput, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

/** 「リリース状態を判定する」を走らせ、出力を返す */
function runState(eventName = "workflow_dispatch") {
  git("update-ref", "refs/remotes/origin/develop", "develop");
  const { githubOutput, env } = baseEnv();
  execFileSync("bash", ["-c", extractRunScript("リリース状態を判定する")], {
    cwd: gitDir,
    encoding: "utf8",
    env: { ...env, EVENT_NAME: eventName },
  });
  return readOutputs(githubOutput);
}

// 上げ幅（BUMP_KIND）を受け取り、ファイル上の版から上げるbump-command（signalyの
// `bump_version.py "$BUMP_KIND"`と同じ形）
const KIND_BUMP_COMMAND =
  'node -e \'const f="package.json";const p=JSON.parse(require("fs").readFileSync(f));let [a,b,c]=p.version.split(".").map(Number);const k=process.env.BUMP_KIND;if(k==="major"){a++;b=0;c=0}else if(k==="minor"){b++;c=0}else{c++}p.version=[a,b,c].join(".");require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\\n")\'';

/** 「バージョンをbumpしてdevelop向けPRを作成する」を走らせ、PR本文を返す */
function runBump({ bumpKind, rebuildFrom, devVersion, bumpCommand }) {
  git("update-ref", "refs/remotes/origin/develop", "develop");
  writeFileSync(path.join(workDir, "release-pr-lines.txt"), "");
  writeFileSync(path.join(workDir, "release-issue-lines.txt"), "- #6 修正\n");
  const { env } = baseEnv();
  const script = extractRunScript("バージョンをbumpしてdevelop向けPRを作成する").replaceAll("/tmp/", `${workDir}/`);
  execFileSync("bash", ["-c", script], {
    cwd: gitDir,
    encoding: "utf8",
    env: {
      ...env,
      MAIN_VERSION: "1.0.0",
      DEV_VERSION: devVersion,
      REBUILD_FROM: rebuildFrom,
      BUMP_KIND: bumpKind,
      REASON: "判断根拠",
      RELEASE_CHANGELOG: "",
      RELEASE_USAGE: "",
      // npm version の代わりに版だけを書き換える（lifecycleの代わりに更新履歴へ1行足す）
      BUMP_COMMAND:
        bumpCommand ??
        'node -e \'const f="package.json";const p=JSON.parse(require("fs").readFileSync(f));p.version=process.env.NEW_VERSION;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\\n")\' && sed -i "1i # v$NEW_VERSION" CHANGELOG.md',
    },
  });
  return readFileSync(path.join(workDir, "release-pr-body.md"), "utf8");
}

describe("リリース状態を判定する（作り直し #3014）", () => {
  it("バンプ後にdevelopへ変更が入っていれば、手動起動でバンプから作り直す", () => {
    mergePullRequest("issue-5", 10);
    const bumpMerge = mergeBump("1.1.0", 11);
    mergePullRequest("issue-6", 12);

    const outputs = runState();
    expect(outputs.need_bump).toBe("true");
    expect(outputs.need_main_pr).toBe("false");
    expect(outputs.rebuild_from).toBe(bumpMerge);
  });

  it("バンプ後に変更が無ければ、従来どおりリリースPRだけを作る", () => {
    mergePullRequest("issue-5", 10);
    mergeBump("1.1.0", 11);

    const outputs = runState();
    expect(outputs.need_bump).toBe("false");
    expect(outputs.need_main_pr).toBe("true");
    expect(outputs.rebuild_from).toBe("");
  });

  it("pushでの起動（バンプPRのマージ直後）では作り直さない", () => {
    mergePullRequest("issue-5", 10);
    mergeBump("1.1.0", 11);
    mergePullRequest("issue-6", 12);

    const outputs = runState("push");
    expect(outputs.need_bump).toBe("false");
    expect(outputs.need_main_pr).toBe("true");
  });

  it("developの版を作ったバンプPRが見つからなければ作り直さない（バンプPR上で版を直した場合）", () => {
    mergePullRequest("issue-5", 10);
    mergePullRequest("release/v1.1.0", 11, () => writeVersion("1.2.0"));
    mergePullRequest("issue-6", 12);

    const outputs = runState();
    expect(outputs.need_main_pr).toBe("true");
    expect(outputs.rebuild_from).toBe("");
  });
});

describe("バージョンをbumpしてdevelop向けPRを作成する（作り直し #3014）", () => {
  it("前回のバンプを取り消し、判定が同じ版なら1つ上のpatchにする", () => {
    mergePullRequest("issue-5", 10);
    const bumpMerge = mergeBump("1.1.0", 11);
    mergePullRequest("issue-6", 12);

    const body = runBump({ bumpKind: "minor", rebuildFrom: bumpMerge, devVersion: "1.1.0" });

    expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("release/v1.1.1");
    expect(readVersion()).toBe("1.1.1");
    // 前回の更新履歴（v1.1.0）は取り消され、作り直した版だけが載る
    expect(readFileSync(path.join(gitDir, "CHANGELOG.md"), "utf8")).toBe("# v1.1.1\n# v1.0.0\n");
    // 修正（issue-6）は残っている
    expect(git("ls-files")).toContain("file-3.txt");
    expect(body).toContain("v1.1.0 のリリースを作り直しています");
    expect(body).toContain("判定どおりの v1.1.0 ではなく v1.1.1");
  });

  it("判定が取り消す版より上なら、その版をそのまま使う", () => {
    mergePullRequest("issue-5", 10);
    const bumpMerge = mergeBump("1.1.0", 11);
    mergePullRequest("issue-6", 12);

    const body = runBump({ bumpKind: "major", rebuildFrom: bumpMerge, devVersion: "1.1.0" });

    expect(readVersion()).toBe("2.0.0");
    expect(body).toContain("v1.1.0 のリリースを作り直しています");
    expect(body).not.toContain("判定どおりの");
  });

  it.each([
    ["minor", "1.1.1"],
    ["major", "2.0.0"],
    ["patch", "1.1.1"],
  ])("上げ幅を受け取るbump-commandでも、作り直した版が計算どおりになる（%s）", (bumpKind, expected) => {
    mergePullRequest("issue-5", 10);
    const bumpMerge = mergeBump("1.1.0", 11);
    mergePullRequest("issue-6", 12);

    const body = runBump({
      bumpKind,
      rebuildFrom: bumpMerge,
      devVersion: "1.1.0",
      bumpCommand: KIND_BUMP_COMMAND,
    });

    expect(readVersion()).toBe(expected);
    expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`release/v${expected}`);
    // 判断根拠には判定どおりの上げ幅を残す（繰り上げで渡したpatchではなく）
    expect(body).toContain(`コード差分の内容から${bumpKind}バージョンと判定しました`);
  });

  it("作り直しでなければ従来どおりmainの版から上げる", () => {
    mergePullRequest("issue-5", 10);

    const body = runBump({ bumpKind: "minor", rebuildFrom: "", devVersion: "1.0.0" });

    expect(readVersion()).toBe("1.1.0");
    expect(body).not.toContain("作り直し");
  });
});
