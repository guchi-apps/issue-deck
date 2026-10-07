#!/usr/bin/env node
// 必須検査の正本（ci/required-checks.json）と、それを実行する2つのCI設定がずれていないかを検査する（#4065）。
//
// - .github/workflows/ci.yml: 定義の各グループに同名のジョブがあり、そのジョブが
//   `run-required-checks.mjs --group <グループ名>` を呼んでいること。定義に無いジョブは
//   通知・情報提供だけのもの（INFORMATIONAL_JOBS）に限ること（必須検査を定義の外へ書くと、
//   バックアップCIでは実行されないまま「同等」と扱われるため）
// - .circleci/config.yml: `run-required-checks.mjs --all` で全グループを実行していること
// - 各検査の `run` が参照するスクリプトが実在すること
//
// 使い方: node scripts/ci/check-ci-definition-sync.mjs

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 必須検査ではない（CIの合否に影響させない）ことが分かっているジョブ */
export const INFORMATIONAL_JOBS = ["workflow-drift-notice", "notify"];

/** `jobs:`直下（インデント2）のジョブ名と、その本文を取り出す */
export function extractJobs(yaml) {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of yaml.replace(/\r/g, "").split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      inJobs = false;
      current = null;
      continue;
    }
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      jobs.set(current, "");
      continue;
    }
    if (current) jobs.set(current, `${jobs.get(current)}${line}\n`);
  }
  return jobs;
}

/** 検査コマンドが参照するリポジトリ内のスクリプト（`scripts/...`）を拾う */
export function referencedScripts(run) {
  return [...run.matchAll(/(?:^|\s)((?:scripts|\.github)\/[\w./-]+\.(?:sh|mjs|js))/g)].map((m) => m[1]);
}

export function checkSync({ manifest, ciYaml, circleYaml, exists }) {
  const errors = [];
  const groups = Object.keys(manifest.groups ?? {});
  if (groups.length === 0) errors.push("required-checks.json にグループがありません");

  const jobs = extractJobs(ciYaml);
  for (const group of groups) {
    const body = jobs.get(group);
    if (body == null) {
      errors.push(`ci.yml にジョブ ${group} がありません（定義のグループ名とジョブ名を揃えてください）`);
      continue;
    }
    const pattern = new RegExp(`run-required-checks\\.mjs\\s+--group\\s+${group}(\\s|$)`);
    if (!pattern.test(body)) {
      errors.push(`ci.yml のジョブ ${group} が run-required-checks.mjs --group ${group} を呼んでいません`);
    }
  }
  for (const job of jobs.keys()) {
    if (!groups.includes(job) && !INFORMATIONAL_JOBS.includes(job)) {
      errors.push(
        `ci.yml のジョブ ${job} が必須検査の定義にありません。検査なら ci/required-checks.json へ、通知だけなら INFORMATIONAL_JOBS へ足してください`,
      );
    }
  }

  if (circleYaml == null) {
    errors.push(".circleci/config.yml がありません");
  } else if (!/run-required-checks\.mjs[^\n]*--all/.test(circleYaml)) {
    errors.push(".circleci/config.yml が run-required-checks.mjs --all を実行していません");
  }

  for (const group of groups) {
    for (const check of manifest.groups[group].checks ?? []) {
      for (const script of referencedScripts(check.run ?? "")) {
        if (!exists(script)) errors.push(`検査 ${check.id} が参照する ${script} がありません`);
      }
    }
  }
  return errors;
}

function main() {
  const read = (p) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : null);
  const errors = checkSync({
    manifest: JSON.parse(read("ci/required-checks.json") ?? "{}"),
    ciYaml: read(".github/workflows/ci.yml") ?? "",
    circleYaml: read(".circleci/config.yml"),
    exists: (p) => existsSync(path.join(ROOT, p)),
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(`NG: ${error}`);
    return 1;
  }
  console.log("OK: ci.yml・.circleci/config.yml が必須検査の定義と一致しています");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
