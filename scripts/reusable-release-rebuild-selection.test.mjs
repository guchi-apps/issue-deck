// `.github/workflows/reusable-release-develop-to-main.yml`の作り直し（#4335）を、実物のgitリポジトリと
// GitHub CLIのスタブに対して実行する。対象は2つ。
//
// - **連続した作り直し**: 未公開のバンプが`release/v1.1.0`→`release/v1.1.1`と積まれた状態でも、全部を
//   取り消して版・更新履歴をmainの状態へ戻し、実装の変更は残したまま作り直せること（2026-10-11の停止）
// - **PRを選んだ作り直し**: 元の候補のheadへ選んだPRのマージ差分だけを当て、選んでいないdevelopの変更が
//   入らないこと。依存・競合・取り込み済み・候補の更新では、理由を示して止まること
//
// `reusable-release-rebuild.test.mjs`と同じく、YAMLから`run:`本文を取り出してそのまま走らせる。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowYaml = readFileSync(path.join(repoRoot, ".github/workflows/reusable-release-develop-to-main.yml"), "utf8");

function extractRunScript(stepName) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`ステップが見つかりません: ${stepName}`);
  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const body = [];
  const indent = lines[runIndex].search(/\S/) + 2;
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// `gh pr view`（元の候補）・`gh pr list`（main向け／マージ済みバンプPRの本文）だけを環境変数で返す
const STUB_GH = `#!/usr/bin/env bash
set -u
echo "$*" >> "$STUB_GH_LOG"
case "$1 $2" in
  "pr view") printf '%s\\n' "\${STUB_GH_PR_VIEW:-}" ;;
  "pr list")
    case "$*" in
      *"--state merged"*) printf '%s\\n' "\${STUB_GH_MERGED_BODY:-}" ;;
      *"--base main"*) printf '%s\\n' "\${STUB_GH_MAIN_PR:-}" ;;
    esac
    ;;
esac
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
const writeVersion = (version) =>
  writeFileSync(path.join(gitDir, "package.json"), `${JSON.stringify({ name: "app", version }, null, 2)}\n`);
const readVersion = () => JSON.parse(readFileSync(path.join(gitDir, "package.json"), "utf8")).version;
const show = (ref, file) => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return null;
  }
};

/** developから切ったブランチで`change`を行い、PRのマージコミットとして取り込む */
function mergePullRequest(branch, number, change) {
  git("checkout", "-q", "-b", branch, "develop");
  change();
  git("add", "-A");
  git("commit", "-q", "-m", branch);
  git("checkout", "-q", "develop");
  git("merge", "-q", "--no-ff", branch, "-m", `Merge pull request #${number} from guchi-apps/${branch}`, "-m", `PR${number}のタイトル`);
  return git("rev-parse", "HEAD").trim();
}
const writeFile = (name, text) => () => writeFileSync(path.join(gitDir, name), text);
/** バンプPR。`changelog`は更新履歴の全文（作り直しのバンプは前回分を消して書き直す） */
const mergeBump = (version, number, changelog) =>
  mergePullRequest(`release/v${version}`, number, () => {
    writeVersion(version);
    writeFileSync(path.join(gitDir, "CHANGELOG.md"), changelog);
  });

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "release-rebuild-selection-"));
  gitDir = path.join(workDir, "repo");
  writeFileSync(path.join(workDir, "gh"), STUB_GH);
  chmodSync(path.join(workDir, "gh"), 0o755);
  writeFileSync(path.join(workDir, "gh.log"), "");
  execFileSync("git", ["init", "-q", "--bare", path.join(workDir, "remote.git")]);
  execFileSync("git", ["init", "-q", "-b", "develop", gitDir]);
  git("remote", "add", "origin", path.join(workDir, "remote.git"));
  writeVersion("1.0.0");
  writeFileSync(path.join(gitDir, "CHANGELOG.md"), "# v1.0.0\n");
  writeFileSync(path.join(gitDir, "shared.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "初期コミット");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function env(extra = {}) {
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
      ...extra,
    },
  };
}
const readOutputs = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/** 「リリース状態を判定する」。失敗したときは`{ failed: true, output }`を返す */
function runState(extra = {}) {
  git("update-ref", "refs/remotes/origin/develop", "develop");
  const { githubOutput, env: e } = env({ EVENT_NAME: "workflow_dispatch", ...extra });
  try {
    // 選んだPRの一覧は`/tmp/`経由でバンプのステップへ渡る。テストでは使い捨てのディレクトリへ向ける
    const script = extractRunScript("リリース状態を判定する").replaceAll("/tmp/", `${workDir}/`);
    execFileSync("bash", ["-c", script], { cwd: gitDir, encoding: "utf8", env: e, stdio: "pipe" });
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
  return readOutputs(githubOutput);
}

const SET_VERSION =
  'node -e \'const f="package.json";const p=JSON.parse(require("fs").readFileSync(f));p.version=process.env.NEW_VERSION;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\\n")\' && sed -i "1i # v$NEW_VERSION" CHANGELOG.md';

function runBump(extra) {
  writeFileSync(path.join(workDir, "release-pr-lines.txt"), "");
  writeFileSync(path.join(workDir, "release-issue-lines.txt"), "- #6 修正\n");
  const script = extractRunScript("バージョンをbumpしてdevelop向けPRを作成する").replaceAll("/tmp/", `${workDir}/`);
  const { env: e } = env({
    MAIN_VERSION: "1.0.0",
    BUMP_KIND: "minor",
    REASON: "判断根拠",
    RELEASE_CHANGELOG: "",
    RELEASE_USAGE: "",
    BUMP_COMMAND: SET_VERSION,
    ...extra,
  });
  try {
    execFileSync("bash", ["-c", script], { cwd: gitDir, encoding: "utf8", env: e, stdio: "pipe" });
  } catch (error) {
    // スクリプト全文ではなく、出力（::error::の行）を失敗の理由にする
    throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
  return readFileSync(path.join(workDir, "release-pr-body.md"), "utf8");
}

/**
 * 本番未反映の候補が2回作り直された状態を作る（main 1.0.0、未公開の1.1.0→1.1.1）。
 * 返すのは、2回目のバンプPRのheadで凍結した候補（`release-main/v1.1.1`の先端）
 */
function buildTwiceRebuiltCandidate() {
  mergePullRequest("issue-5", 10, writeFile("feature-5.txt", "5\n"));
  mergeBump("1.1.0", 11, "# v1.1.0\n# v1.0.0\n");
  mergePullRequest("issue-6", 12, writeFile("feature-6.txt", "6\n"));
  const secondBump = mergeBump("1.1.1", 13, "# v1.1.1\n# v1.0.0\n");
  return git("rev-parse", `${secondBump}^2`).trim();
}

describe("連続した作り直し（#4335）", () => {
  it("未公開のバンプが2回積まれていても、全部を新しい順に取り消してmainの版へ戻す", () => {
    buildTwiceRebuiltCandidate();
    mergePullRequest("issue-7", 14, writeFile("feature-7.txt", "7\n"));

    const outputs = runState();
    expect(outputs.need_bump).toBe("true");
    const merges = git("log", "--first-parent", "--merges", "--format=%H %s", "origin/main..develop")
      .trim()
      .split("\n")
      .filter((line) => line.includes("/release/v"))
      .map((line) => line.split(" ")[0]);
    expect(outputs.rebuild_reverts).toBe(merges.join(" "));

    const body = runBump({
      DEV_VERSION: "1.1.1",
      REBUILD_FROM: outputs.rebuild_from,
      REBUILD_REVERTS: outputs.rebuild_reverts,
    });
    // 以前はここで「取り消した後の版（1.1.0）がmain（1.0.0）と一致しません」で止まっていた
    expect(readVersion()).toBe("1.1.2");
    expect(readFileSync(path.join(gitDir, "CHANGELOG.md"), "utf8")).toBe("# v1.1.2\n# v1.0.0\n");
    // 実装の変更は全部残る
    expect(git("ls-files")).toEqual(expect.stringContaining("feature-5.txt"));
    expect(git("ls-files")).toEqual(expect.stringContaining("feature-6.txt"));
    expect(git("ls-files")).toEqual(expect.stringContaining("feature-7.txt"));
    expect(body).toContain("v1.1.1 のリリースを作り直しています");
  });

  it("バンプPR以外で版を書き換えたコミットがあれば、そのコミットを示して止める（一致の検査は残す）", () => {
    mergePullRequest("issue-8", 15, () => writeVersion("1.0.5"));
    mergeBump("1.1.0", 16, "# v1.1.0\n# v1.0.0\n");
    mergePullRequest("issue-9", 17, writeFile("feature-9.txt", "9\n"));
    const outputs = runState();
    expect(outputs.rebuild_from).not.toBe("");

    expect(() =>
      runBump({ DEV_VERSION: "1.1.0", REBUILD_FROM: outputs.rebuild_from, REBUILD_REVERTS: outputs.rebuild_reverts }),
    ).toThrow(/一致しません。バンプPR以外で版を書き換えたコミットがあります: .*issue-8/);
  });
});

describe("PRを選んだ作り直し（#4335）", () => {
  function setup() {
    const origin = buildTwiceRebuiltCandidate();
    const a = mergePullRequest("issue-20", 20, writeFile("shared.txt", "base\nA\n"));
    const b = mergePullRequest("issue-21", 21, writeFile("unrelated.txt", "B\n"));
    const c = mergePullRequest("issue-22", 22, writeFile("shared.txt", "base\nA2\n"));
    return { origin, a, b, c };
  }
  const selection = (origin, prs) => JSON.stringify({ origin: { pr: 99, headSha: origin }, prs });
  const view = (origin) =>
    JSON.stringify({ state: "OPEN", baseRefName: "main", headRefName: "release-main/v1.1.1", headRefOid: origin });

  it("選んだPR（A）だけを元の候補へ足し、選んでいないB・Cは入らない", () => {
    const { origin, a } = setup();
    const outputs = runState({
      REBUILD_SELECTION: selection(origin, [{ number: 20, mergeSha: a }]),
      STUB_GH_PR_VIEW: view(origin),
    });

    expect(outputs).toMatchObject({ need_bump: "true", develop_ref: "rebuild-preview", selective: "true", rebuild_from: origin, dev_version: "1.1.1" });
    expect(show("rebuild-preview", "shared.txt")).toBe("base\nA\n");
    expect(show("rebuild-preview", "unrelated.txt")).toBeNull();
    // 元の候補の内容（feature-5/6）は保持する
    expect(show("rebuild-preview", "feature-6.txt")).toBe("6\n");
  });

  it("後継の候補とdevelopへのバンプPRを分け、バンプPRには版の書き換えだけを出す", () => {
    const { origin, a } = setup();
    const sel = selection(origin, [{ number: 20, mergeSha: a }]);
    const outputs = runState({ REBUILD_SELECTION: sel, STUB_GH_PR_VIEW: view(origin) });

    const body = runBump({
      DEV_VERSION: "1.1.1",
      REBUILD_FROM: outputs.rebuild_from,
      REBUILD_REVERTS: outputs.rebuild_reverts,
      DEVELOP_REF: "rebuild-preview",
      SELECTIVE: "true",
      REBUILD_SELECTION: sel,
    });

    const candidate = git("ls-remote", "origin", "refs/heads/release-candidate/v1.1.2").split("\t")[0];
    expect(show(candidate, "package.json")).toContain('"version": "1.1.2"');
    expect(show(candidate, "shared.txt")).toBe("base\nA\n");
    expect(show(candidate, "unrelated.txt")).toBeNull();
    // バンプPR（developへ）の差分は版・更新履歴だけ
    expect(git("diff", "--name-only", "develop", "release/v1.1.2").trim().split("\n").sort()).toEqual(["CHANGELOG.md", "package.json"]);
    expect(body).toContain("<!-- issue-deck-rebuild-origin:#99 -->");
    expect(body).toContain(`<!-- issue-deck-rebuild-candidate:${candidate} -->`);
    expect(body).toContain("- #20 PR20のタイトル");
  });

  it("依存するPR（A）を選ばずにCだけを選ぶと、競合と必要なPRを示して止める（選択は広げない）", () => {
    const { origin, c } = setup();
    const result = runState({
      REBUILD_SELECTION: selection(origin, [{ number: 22, mergeSha: c }]),
      STUB_GH_PR_VIEW: view(origin),
    });
    expect(result.failed).toBe(true);
    expect(result.output).toContain("#22 を元の候補 #99 へそのまま適用できません");
    expect(result.output).toContain("先に必要な可能性があるPR: #20");
  });

  it("選んだ順によらず、developへ入った順に当てる（C,Aの指定でも通る）", () => {
    const { origin, a, c } = setup();
    const outputs = runState({
      REBUILD_SELECTION: selection(origin, [{ number: 22, mergeSha: c }, { number: 20, mergeSha: a }]),
      STUB_GH_PR_VIEW: view(origin),
    });
    expect(outputs.selective).toBe("true");
    expect(show("rebuild-preview", "shared.txt")).toBe("base\nA2\n");
  });

  it("元の候補に既に含まれているPRは理由を示して止める", () => {
    const { origin } = setup();
    const included = git("log", "--format=%H", "--grep=^Merge pull request #12 ", "-1", "develop").trim();
    const result = runState({
      REBUILD_SELECTION: selection(origin, [{ number: 12, mergeSha: included }]),
      STUB_GH_PR_VIEW: view(origin),
    });
    expect(result.failed).toBe(true);
    expect(result.output).toContain("#12 は元の候補 #99 に既に含まれています");
  });

  it("元の候補が選んだ後に更新されていたら作らない", () => {
    const { origin, a } = setup();
    const result = runState({
      REBUILD_SELECTION: selection(origin, [{ number: 20, mergeSha: a }]),
      STUB_GH_PR_VIEW: view("0".repeat(40)),
    });
    expect(result.failed).toBe(true);
    expect(result.output).toContain("元の候補 #99 が更新・取消されています");
  });

  it("PR番号と指定コミットが食い違えば作らない（番号だけを信じない）", () => {
    const { origin, b } = setup();
    const result = runState({
      REBUILD_SELECTION: selection(origin, [{ number: 20, mergeSha: b }]),
      STUB_GH_PR_VIEW: view(origin),
    });
    expect(result.failed).toBe(true);
    expect(result.output).toContain("そのPRのdevelopへのマージではありません");
  });

  it("バンプPRのマージで起きたrunは、元の候補を閉じる対象として扱い後継のリリースPRを作る", () => {
    setup();
    mergeBump("1.1.2", 30, "# v1.1.2\n# v1.0.0\n");
    const outputs = runState({
      EVENT_NAME: "push",
      STUB_GH_MAIN_PR: JSON.stringify({ number: 99, url: "https://example/99", headRefName: "release-main/v1.1.1" }),
      STUB_GH_MERGED_BODY: "本文\n<!-- issue-deck-rebuild-origin:#99 -->\n",
    });
    expect(outputs).toMatchObject({ need_main_pr: "true", close_origin: "99", close_origin_ref: "release-main/v1.1.1" });
  });

  it("目印の無い（別の）リリースPRが開いていれば、従来どおり作らない", () => {
    setup();
    mergeBump("1.1.2", 30, "# v1.1.2\n# v1.0.0\n");
    const outputs = runState({
      EVENT_NAME: "push",
      STUB_GH_MAIN_PR: JSON.stringify({ number: 98, url: "https://example/98", headRefName: "release-main/v1.1.1" }),
      STUB_GH_MERGED_BODY: "本文\n<!-- issue-deck-rebuild-origin:#99 -->\n",
    });
    expect(outputs).toMatchObject({ need_main_pr: "false", close_origin: "" });
  });
});
