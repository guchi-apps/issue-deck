// `scripts/sync-labels.sh`を、状態を持つ`gh`のスタブに対して実行する（#3237）。
//
// このスクリプトは全リポジトリのラベルを書き換える。**失敗経路（一部のリポジトリで落ちる・
// 付け替えが途中で失敗する）と冪等性は、実リポジトリでは試せない**ため、GitHubのラベルAPIの
// 必要な部分だけを再現したスタブで確かめる。スタブは呼ばれた書き込みを記録するので、
// 「dry-runは何も書かない」「収束後の再実行は何も書かない」も直接検証できる。

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/sync-labels.sh");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".github/labels.json"), "utf8"));

const STUB_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.STUB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (value) => process.stdout.write(JSON.stringify(value));
const fail = (status, message) => {
  // 実際のghは失敗時もエラーJSONを標準出力へ出す
  process.stdout.write(JSON.stringify({ message, status: String(status) }));
  process.stderr.write("gh: " + message + " (HTTP " + status + ")\\n");
  process.exit(1);
};
const lc = (s) => s.toLowerCase();

if (args[0] === "repo" && args[1] === "list") {
  out(state.repos);
  process.exit(0);
}

if (args[0] !== "api") fail(500, "unsupported: " + args.join(" "));

let method = null;
const fields = [];
let target = null;
for (let i = 1; i < args.length; i += 1) {
  const a = args[i];
  if (a === "-X") method = args[++i];
  else if (a === "-f") fields.push(args[++i]);
  else if (a === "--paginate") continue;
  else target = a;
}
const [rawPath, query = ""] = target.split("?");
const params = Object.fromEntries(
  fields.map((f) => {
    const at = f.indexOf("=");
    return [f.slice(0, at), f.slice(at + 1)];
  }),
);
for (const pair of query.split("&").filter(Boolean)) {
  const at = pair.indexOf("=");
  params[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
}
if (!method) method = fields.length > 0 ? "POST" : "GET";

const m = /^repos\\/([^/]+\\/[^/]+)\\/(labels|issues)(?:\\/(.+))?$/.exec(rawPath);
if (!m) fail(404, "Not Found: " + rawPath);
const [, repo, kind, rest] = m;
if ((state.failRepos || []).includes(repo)) fail(403, "Resource not accessible");
state.labels[repo] ||= [];
state.issues[repo] ||= [];
const labels = state.labels[repo];
const findLabel = (name) => labels.find((l) => lc(l.name) === lc(name));
const write = (entry) => {
  state.writes.push(entry);
  save();
};

if (kind === "labels" && !rest) {
  if (method === "GET") out(labels);
  else {
    if (findLabel(params.name)) fail(422, "already_exists");
    labels.push({ name: params.name, color: params.color, description: params.description ?? "" });
    write("POST " + repo + " labels " + params.name);
    out({ name: params.name });
  }
} else if (kind === "labels") {
  const name = decodeURIComponent(rest);
  const label = findLabel(name);
  if (!label) fail(404, "Not Found");
  if (method === "PATCH") {
    if (params.new_name !== undefined) {
      const clash = findLabel(params.new_name);
      if (clash && clash !== label) fail(422, "already_exists");
      for (const issue of state.issues[repo]) {
        issue.labels = issue.labels.map((l) => (l === label.name ? params.new_name : l));
      }
      label.name = params.new_name;
    }
    if (params.color !== undefined) label.color = params.color;
    if (params.description !== undefined) label.description = params.description;
    write("PATCH " + repo + " labels " + name);
    out(label);
  } else if (method === "DELETE") {
    state.labels[repo] = labels.filter((l) => l !== label);
    for (const issue of state.issues[repo]) issue.labels = issue.labels.filter((l) => l !== label.name);
    write("DELETE " + repo + " labels " + name);
  } else fail(405, "method");
} else if (kind === "issues" && !rest) {
  const wanted = params.labels;
  out(state.issues[repo].filter((i) => i.labels.some((l) => lc(l) === lc(wanted))).map((i) => ({ number: i.number })));
} else {
  const number = Number(/^(\\d+)\\/labels$/.exec(rest)?.[1]);
  const issue = state.issues[repo].find((i) => i.number === number);
  if (!issue) fail(404, "Not Found");
  if ((state.failIssuePost || []).includes(repo + "#" + number)) fail(502, "Bad Gateway");
  const added = params["labels[]"];
  if (!findLabel(added)) fail(404, "label not found");
  if (!issue.labels.includes(added)) issue.labels.push(added);
  write("POST " + repo + " issues/" + number + " labels " + added);
  out(issue.labels);
}
`;

let dir;
let statePath;

function label(name, color = "ededed", description = "") {
  return { name, color, description };
}

function initState(overrides = {}) {
  const state = {
    repos: [],
    labels: {},
    issues: {},
    failRepos: [],
    failIssuePost: [],
    writes: [],
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(state));
}

function readState() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function run(...scriptArgs) {
  const result = spawnSync("bash", [scriptPath, ...scriptArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}/bin:${process.env.PATH}`,
      STUB_STATE: statePath,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 旧世代のラベルを持つリポジトリ。大文字小文字だけの違い・色違い・管理外ラベルを含む */
const LEGACY_LABELS = [
  label("30.bug", "b60205", "不具合"),
  label("40.unexpected", "d93f0b", "想定外の動作"),
  label("70.confirm", "5319e7", "確認項目"),
  label("89.Priority: low", "fef2c0", "緊急 低"),
  label("90.Close: duplicate", "c5def5", "重複"),
  label("90.Close: invalid", "c5def5", "無効"),
  label("90.Close: wonfix", "c5def5", "見送り"),
  label("bug", "d73a4a", "GitHub既定"),
];

function repoEntry(name, extra = {}) {
  return { nameWithOwner: `guchi-apps/${name}`, isArchived: false, visibility: "PUBLIC", ...extra };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sync-labels-"));
  statePath = path.join(dir, "state.json");
  const bin = path.join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(path.join(bin, "gh"), STUB_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expectConverged(labels) {
  const byName = new Map(labels.map((l) => [l.name, l]));
  for (const want of manifest.labels) {
    const got = byName.get(want.name);
    expect(got, `${want.name}が無い`).toBeDefined();
    expect(got.color.toLowerCase()).toBe(want.color.toLowerCase());
    expect(got.description).toBe(want.description);
  }
  for (const rename of manifest.renames) {
    if (rename.from.toLowerCase() === rename.to.toLowerCase()) continue;
    expect(byName.has(rename.from), `${rename.from}が残っている`).toBe(false);
  }
}

// スタブの`gh`を1呼び出しごとにnodeで起動するため、リポジトリ数×ラベル数の分だけ時間がかかる
describe("sync-labels.sh", { timeout: 60_000 }, () => {
  it("dry-runは何も書き込まず、変更対象と件数を出す", () => {
    initState({
      repos: [repoEntry("app")],
      labels: { "guchi-apps/app": LEGACY_LABELS },
      issues: { "guchi-apps/app": [{ number: 1, labels: ["70.confirm"] }] },
    });

    const result = run("dry-run");

    expect(result.status).toBe(0);
    expect(readState().writes).toEqual([]);
    expect(result.stdout).toContain("改名    70.confirm → 70.needs-decision（付与済み 1 件");
    expect(result.stdout).toContain("作成    85.Priority: Medium");
    expect(result.stdout).toContain("dry-run");
    // 引数を省略してもdry-runになる（誤って書き込まないため）
    expect(run().stdout).toContain("モード: dry-run");
  });

  it("applyで正本へ収束し、旧ラベルの付与状態が新名へ引き継がれる", () => {
    initState({
      repos: [repoEntry("app")],
      labels: { "guchi-apps/app": LEGACY_LABELS },
      issues: {
        "guchi-apps/app": [
          { number: 1, labels: ["70.confirm", "40.unexpected"] },
          { number: 2, labels: ["90.Close: wonfix", "89.Priority: low"] },
        ],
      },
    });

    const result = run("apply");

    expect(result.status).toBe(0);
    const state = readState();
    expectConverged(state.labels["guchi-apps/app"]);
    expect(state.issues["guchi-apps/app"]).toEqual([
      { number: 1, labels: ["70.needs-decision", "40.investigation"] },
      { number: 2, labels: ["94.Close: wontfix", "89.Priority: Low"] },
    ]);
    // 管理外のラベルは消さない
    expect(state.labels["guchi-apps/app"].map((l) => l.name)).toContain("bug");
    expect(result.stdout).toContain("管理外（削除しない）: bug");
  });

  it("収束後の再実行は何も書き込まず、重複ラベルも作らない", () => {
    initState({ repos: [repoEntry("app")], labels: { "guchi-apps/app": LEGACY_LABELS } });
    expect(run("apply").status).toBe(0);
    const afterFirst = readState();
    afterFirst.writes = [];
    writeFileSync(statePath, JSON.stringify(afterFirst));

    const second = run("apply");

    expect(second.status).toBe(0);
    const state = readState();
    expect(state.writes).toEqual([]);
    expect(second.stdout).toContain("変更なし");
    expect(second.stdout).toContain("成功（変更なし）: 1 件");
    const names = state.labels["guchi-apps/app"].map((l) => l.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("新名が既にあるときはIssueを付け替えてから旧ラベルを削除する", () => {
    initState({
      repos: [repoEntry("app")],
      labels: {
        "guchi-apps/app": [
          label("90.Close: duplicate", "c5def5", "旧"),
          label("91.Close: duplicate", "c5def5", "既存の新名"),
        ],
      },
      issues: {
        "guchi-apps/app": [
          { number: 7, labels: ["90.Close: duplicate"] },
          { number: 8, labels: ["90.Close: duplicate", "91.Close: duplicate"] },
        ],
      },
    });

    const result = run("apply");

    expect(result.status).toBe(0);
    const state = readState();
    expect(state.labels["guchi-apps/app"].map((l) => l.name)).not.toContain("90.Close: duplicate");
    expect(state.issues["guchi-apps/app"]).toEqual([
      { number: 7, labels: ["91.Close: duplicate"] },
      { number: 8, labels: ["91.Close: duplicate"] },
    ]);
    expect(result.stdout).toContain("付け替え 90.Close: duplicate → 91.Close: duplicate（2 件");
  });

  it("付け替えに1件でも失敗したら旧ラベルを削除せず、失敗として数える", () => {
    initState({
      repos: [repoEntry("app")],
      labels: {
        "guchi-apps/app": [label("90.Close: duplicate"), label("91.Close: duplicate")],
      },
      issues: {
        "guchi-apps/app": [
          { number: 7, labels: ["90.Close: duplicate"] },
          { number: 8, labels: ["90.Close: duplicate"] },
        ],
      },
      failIssuePost: ["guchi-apps/app#8"],
    });

    const result = run("apply");

    expect(result.status).toBe(1);
    const state = readState();
    expect(state.labels["guchi-apps/app"].map((l) => l.name)).toContain("90.Close: duplicate");
    expect(state.issues["guchi-apps/app"][1].labels).toEqual(["90.Close: duplicate"]);
    expect(result.stdout).toContain("失敗: 1 件");
  });

  it("アーカイブ済みは変更せずスキップとして出す", () => {
    initState({
      repos: [repoEntry("live"), repoEntry("old", { isArchived: true })],
      labels: { "guchi-apps/live": [], "guchi-apps/old": LEGACY_LABELS },
    });

    const result = run("apply");

    expect(result.status).toBe(0);
    const state = readState();
    expect(state.labels["guchi-apps/old"]).toEqual(LEGACY_LABELS);
    expect(state.writes.some((w) => w.includes("guchi-apps/old"))).toBe(false);
    expect(result.stdout).toContain("スキップ: 1 件");
    expect(result.stdout).toContain("guchi-apps/old（アーカイブ済み）");
  });

  it("privateを含む全リポジトリを、最近のpushの有無に関係なく処理する", () => {
    initState({
      repos: [
        repoEntry("a"),
        repoEntry("secret", { visibility: "PRIVATE" }),
        // pushedAtのような追加項目があっても、対象を落とす条件には使わない
        repoEntry("dormant", { pushedAt: "2020-01-01T00:00:00Z" }),
      ],
      labels: { "guchi-apps/a": [], "guchi-apps/secret": [], "guchi-apps/dormant": [] },
    });

    const result = run("apply");

    expect(result.status).toBe(0);
    const state = readState();
    for (const repo of ["a", "secret", "dormant"]) {
      expectConverged(state.labels[`guchi-apps/${repo}`]);
    }
    expect(result.stdout).toContain("成功（変更あり）: 3 件");
  });

  it("一部のリポジトリで失敗しても残りを処理し、最後に失敗を一覧して1で終わる", () => {
    initState({
      repos: [repoEntry("broken"), repoEntry("fine")],
      labels: { "guchi-apps/broken": [], "guchi-apps/fine": [] },
      failRepos: ["guchi-apps/broken"],
    });

    const result = run("apply");

    expect(result.status).toBe(1);
    expectConverged(readState().labels["guchi-apps/fine"]);
    expect(result.stdout).toContain("成功（変更あり）: 1 件");
    expect(result.stdout).toContain("失敗: 1 件");
    expect(result.stdout).toMatch(/失敗: 1 件\n {2}- guchi-apps\/broken/);
  });

  it("--repoで対象を絞れ、存在しない指定は失敗として数える", () => {
    initState({
      repos: [repoEntry("a"), repoEntry("b")],
      labels: { "guchi-apps/a": [], "guchi-apps/b": [] },
    });

    const result = run("apply", "--repo", "a", "--repo", "guchi-apps/nothing");

    expect(result.status).toBe(1);
    const state = readState();
    expect(state.labels["guchi-apps/a"].length).toBe(manifest.labels.length);
    expect(state.labels["guchi-apps/b"]).toEqual([]);
    expect(result.stdout).toContain("guchi-apps/nothing（一覧に存在しない）");
  });

  it("正本が壊れているときは何も書かずに終了コード2で止まる", () => {
    initState({ repos: [repoEntry("a")], labels: { "guchi-apps/a": [] } });
    const broken = path.join(dir, "broken.json");
    writeFileSync(
      broken,
      JSON.stringify({ labels: [label("x", "ededed"), label("X", "ededed")], renames: [] }),
    );

    const result = run("apply", "--manifest", broken);

    expect(result.status).toBe(2);
    expect(readState().writes).toEqual([]);
    expect(result.stderr).toContain("正本の形式が不正");
  });
});
