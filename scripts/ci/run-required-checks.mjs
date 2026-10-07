#!/usr/bin/env node
// develop向けPRの必須検査を、正本（ci/required-checks.json）どおりに実行する（#4065）。
//
// GitHub Actions（.github/workflows/ci.yml）はジョブごとに `--group <ジョブ名>` で、
// バックアップCI（.circleci/config.yml）は `--all` で呼ぶ。検査の中身を1か所に置くことで、
// 「Actionsでは落ちるがCircleCIでは通る」差が生まれないようにする。
//
// 1つが失敗しても残りは実行し（内訳を全部出すため）、最後に1件でも失敗があれば終了コード1で
// 終わる。`--result <path>`を付けると、検査ごとの結果と定義のダイジェスト（sha256）をJSONで
// 書き出す。issue-deckはこのダイジェストを、PRのbaseにある定義のダイジェストと突き合わせ、
// 違えば合格として採用しない（PR内で定義を書き換えて検査を省く経路を塞ぐ）。
//
// 使い方:
//   node scripts/ci/run-required-checks.mjs --group lint-and-build
//   node scripts/ci/run-required-checks.mjs --all --result ci-result.json
//   node scripts/ci/run-required-checks.mjs --all --manifest /trusted/required-checks.json
//   node scripts/ci/run-required-checks.mjs --list            # 実行せず一覧を出す

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 定義ファイルの生バイトのsha256。issue-deck側（src/lib/backup-ci/definition.ts）と同じ計算 */
export function digestDefinition(raw) {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** 定義を検査の一覧へ展開する。形が崩れていれば例外にする（黙って0件で通さない） */
export function expandChecks(manifest, groupNames) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.groups !== "object") {
    throw new Error("required-checks.json の形式が不正です（schemaVersion: 1 と groups が必要です）");
  }
  const names = groupNames ?? Object.keys(manifest.groups);
  if (names.length === 0) throw new Error("実行するグループがありません");
  const checks = [];
  for (const name of names) {
    const group = manifest.groups[name];
    if (!group || !Array.isArray(group.checks) || group.checks.length === 0) {
      throw new Error(`グループ ${name} が定義にありません（または検査が0件です）`);
    }
    for (const check of group.checks) {
      if (typeof check.id !== "string" || typeof check.run !== "string") {
        throw new Error(`グループ ${name} に id または run の無い検査があります`);
      }
      checks.push({ group: name, id: check.id, name: check.name ?? check.id, run: check.run, env: check.env ?? {} });
    }
  }
  return checks;
}

function parseArgs(argv) {
  const args = { groups: [], all: false, result: null, manifest: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--group") args.groups.push(argv[++i]);
    else if (arg === "--all") args.all = true;
    else if (arg === "--result") args.result = argv[++i];
    else if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--list") args.list = true;
    else throw new Error(`不明な引数です: ${arg}`);
  }
  if (!args.all && args.groups.length === 0 && !args.list) {
    throw new Error("--group <名前> か --all を指定してください");
  }
  return args;
}

function git(args) {
  const res = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest ?? path.join(ROOT, "ci/required-checks.json");
  const raw = readFileSync(manifestPath);
  const manifest = JSON.parse(raw.toString("utf8"));
  const checks = expandChecks(manifest, args.all || args.list ? null : args.groups);
  const definitionDigest = digestDefinition(raw);

  if (args.list) {
    for (const check of checks) console.log(`${check.group}\t${check.id}\t${check.run}`);
    console.log(`definition: ${definitionDigest}`);
    return 0;
  }

  const inActions = process.env.GITHUB_ACTIONS === "true";
  const startedAt = new Date().toISOString();
  const results = [];
  for (const check of checks) {
    const begin = Date.now();
    console.log(inActions ? `::group::${check.name}` : `\n=== [${check.group}] ${check.name}`);
    const res = spawnSync("bash", ["-c", check.run], {
      stdio: "inherit",
      env: { ...process.env, ...check.env },
    });
    if (inActions) console.log("::endgroup::");
    const exitCode = res.status ?? 1;
    const passed = exitCode === 0 && res.error == null;
    results.push({
      group: check.group,
      id: check.id,
      name: check.name,
      status: passed ? "passed" : "failed",
      exitCode,
      durationMs: Date.now() - begin,
    });
    if (!passed) {
      console.log(inActions ? `::error::${check.name} が失敗しました（終了コード ${exitCode}）` : `NG: ${check.name}（終了コード ${exitCode}）`);
    }
  }

  const failed = results.filter((r) => r.status !== "passed");
  console.log("\n=== 必須検査の結果");
  for (const r of results) console.log(`${r.status === "passed" ? "OK" : "NG"}  [${r.group}] ${r.name}`);
  console.log(`definition: ${definitionDigest}`);

  if (args.result) {
    const payload = {
      schemaVersion: 1,
      definitionDigest,
      groups: [...new Set(checks.map((c) => c.group))],
      testedSha: git(["rev-parse", "HEAD"]),
      // 検査したコミットの親。バックアップCIはbaseへheadを--no-ffでマージした結果を検査するので
      // [base, head] になる（GitHubのマージ結果の検証と同じ対象。headだけの検査で代用しない）
      testedParents: (git(["rev-parse", "HEAD^@"]) ?? "").split("\n").filter(Boolean),
      // バックアップCIは要求されたhead/baseをここへ渡す（.circleci/config.yml）。issue-deckは
      // 起動時に記録したSHAと一致しなければ採用しない
      requestedHeadSha: process.env.REQUIRED_CHECKS_HEAD_SHA || null,
      requestedBaseSha: process.env.REQUIRED_CHECKS_BASE_SHA || null,
      runRequestId: process.env.REQUIRED_CHECKS_RUN_REQUEST_ID || null,
      startedAt,
      finishedAt: new Date().toISOString(),
      checks: results,
    };
    writeFileSync(args.result, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
