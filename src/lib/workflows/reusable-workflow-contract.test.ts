import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 再利用可能ワークフロー（on: workflow_call）を呼ぶときの権限の契約を固定する（#1181）。
//
// **トップレベルの concurrency・permissions は原因ではない。** 実際 deploy-preview.yml は
// concurrency を、reusable-issue-labels.yml は permissions をトップレベルに持ちながら
// 正常に呼び出せている。startup_failure の真因は権限の超過だけだった。
//
// **権限の超過は startup_failure になり、ジョブが1つも作られずログも残らない。**
// `gh run view` も「This run likely failed because of a workflow file issue.」としか出さず、
// YAMLとしては妥当なので構文チェックも通る。#1181 で実際に踏んだ。
//
// YAMLパーサは依存に無いため、必要な構造だけを行頭のインデントから読む。
const WORKFLOWS_DIR = join(process.cwd(), ".github", "workflows");

function workflowNames(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".yml"));
}

function read(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), "utf8");
}

/** `on:` に `workflow_call` を持つか（= 再利用可能ワークフロー） */
function isReusable(source: string): boolean {
  const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(source);
  return on ? /^ {2}workflow_call:/m.test(on[1] as string) : false;
}

/** トップレベル（インデント0）のキー一覧 */
function topLevelKeys(source: string): string[] {
  return [...source.matchAll(/^([a-z-]+):/gm)].map((m) => m[1] as string);
}

/**
 * `jobs:` 配下の各ジョブから `uses:` と `permissions:` を取り出す。
 * ジョブは4スペース、その中身は6スペースのインデント。
 */
function jobs(source: string): Map<string, { uses?: string; permissions: Map<string, string> }> {
  const result = new Map<string, { uses?: string; permissions: Map<string, string> }>();
  const jobsSection = /^jobs:\n([\s\S]*)$/m.exec(source);
  if (!jobsSection) return result;

  const blocks = (jobsSection[1] as string).split(/^ {2}(?=[a-z][a-z0-9-]*:)/m).slice(1);
  for (const block of blocks) {
    const name = /^([a-z][a-z0-9-]*):/.exec(block)?.[1];
    if (!name) continue;

    const uses = /^ {4}uses: (\S+)/m.exec(block)?.[1];
    const permissions = new Map<string, string>();
    const permBlock = /^ {4}permissions:\n((?: {6}\S+: \S+\n)+)/m.exec(block);
    if (permBlock) {
      for (const line of (permBlock[1] as string).trim().split("\n")) {
        const [scope, level] = line.trim().split(": ");
        if (scope && level) permissions.set(scope, level);
      }
    }
    result.set(name, { uses, permissions });
  }
  return result;
}

/** 権限の強さ。呼ばれる側は caller の範囲を超えられない */
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

describe("再利用可能ワークフローの契約", () => {
  it("再利用可能ワークフローを検出できている（テスト自体の健全性）", () => {
    const reusable = workflowNames().filter((name) => isReusable(read(name)));

    expect(reusable.length).toBeGreaterThanOrEqual(3);
    expect(reusable).toContain("reusable-release-develop-to-main.yml");
  });

  it("呼ばれる側の権限が caller の付与範囲を超えない", () => {
    // 通常のワークフローでは job が workflow レベルの既定を上回る指定をしてよいが、
    // 再利用可能ワークフローでは caller が渡した範囲が上限になる。実際 notify-failure が
    // issues: write を要求し、caller が issues: read しか渡していなかったため失敗した。
    for (const callerName of workflowNames()) {
      for (const [jobName, job] of jobs(read(callerName))) {
        // ローカルパス参照のcallerだけを対象にする（他リポジトリ参照は解決できない）
        if (!job.uses?.startsWith("./.github/workflows/")) continue;

        const calledName = job.uses.replace("./.github/workflows/", "");
        for (const [calledJobName, calledJob] of jobs(read(calledName))) {
          for (const [scope, level] of calledJob.permissions) {
            const granted = job.permissions.get(scope) ?? "none";
            expect(
              RANK[level] ?? 0,
              `${callerName} の ${jobName} が渡す ${scope}=${granted} では、` +
                `${calledName} の ${calledJobName} が要求する ${scope}=${level} を満たせない`,
            ).toBeLessThanOrEqual(RANK[granted] ?? 0);
          }
        }
      }
    }
  });
});
