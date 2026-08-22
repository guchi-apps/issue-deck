// `.github/workflows/reusable-sync-secrets.yml`の同期ステップを、同期スクリプトを
// スタブに差し替えて実行する（#2049）。
//
// **このステップの目的は「何が失敗したか」を画面とログへ返すことなのに、失敗したときだけ
// 何も出なかった。** GitHub Actionsの`run:`は既定シェル`bash -e {0}`で走り、ステップ冒頭の
// `set -uo pipefail`は-uとpipefailを足すだけで-eを打ち消さない。同期スクリプトが非ゼロで
// 終わった瞬間にステップが終わり、`cat "$LOG"`にも集計にも到達していなかった。
//
// 失敗経路は実際に走らせないと確かめられないため、YAMLから`run:`本文を取り出して
// `bash -e`（＝Actionsと同じ既定シェル）で実行する。**この起動方法自体がテストの一部。**

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/reusable-sync-secrets.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

const SYNC_STEP = "1Password から GitHub へ同期する";

/**
 * ステップ名から`run: |`の本文を取り出す。YAMLパーサを足さずに済ませるための最小実装で、
 * `- name:`の直後のステップ定義に`run: |`がブロックスカラーで続く書き方だけを想定する
 * （`scripts/reusable-issue-labels.test.mjs`と同じ実装）。
 */
function extractRunScript(stepName) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`ステップが見つかりません: ${stepName}`);

  const runIndex = lines.findIndex(
    (line, index) => index > start && line.trim() === "run: |",
  );
  if (runIndex < 0) throw new Error(`run: が見つかりません: ${stepName}`);

  const body = [];
  const indent = lines[runIndex].search(/\S/) + 2;
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sync-secrets-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * `scripts/sync-github-secrets.sh`の代わりに置くスタブ。渡した行をそのまま出力し、
 * 指定の終了コードで終わる。**本物と同じく、1件でも失敗すれば非ゼロで終わる**という
 * 性質だけを再現すればこのステップの挙動は確かめられる。
 */
function stubScript(lines, exitCode) {
  const file = path.join(workDir, "sync-github-secrets.sh");
  writeFileSync(
    file,
    `#!/usr/bin/env bash\necho "args: $*"\n${lines
      .map((line) => `printf '%s\\n' ${JSON.stringify(line)}`)
      .join("\n")}\nexit ${exitCode}\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** ステップを1回実行し、標準出力・GITHUB_OUTPUT・ステップサマリを返す */
function runSyncStep({ lines, exitCode, env = {} }) {
  const script = path.join(workDir, "step.sh");
  writeFileSync(script, extractRunScript(SYNC_STEP));
  const outputFile = path.join(workDir, "github_output.txt");
  const summaryFile = path.join(workDir, "github_step_summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        OP_SERVICE_ACCOUNT_TOKEN: "dummy-op-token",
        GH_TOKEN: "dummy-gh-token",
        REPO: "guchi-apps/car-care",
        SCRIPT_PATH: stubScript(lines, exitCode),
        MANIFEST: "",
        ONLY: "",
        LOG: path.join(workDir, "sync-secrets.log"),
        ...env,
      },
    });
  } catch (error) {
    status = error.status ?? 1;
    stdout = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const output = readFileSync(outputFile, "utf8");
  const outputs = Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

  return { status, stdout, outputs, summary: readFileSync(summaryFile, "utf8") };
}

// #2049の実例（guchi-apps/car-care のrun 32508404360）と同じ形。1Password側にフィールドが
// 無く、スクリプトはFAIL行と集計を出したうえで非ゼロで終わる
const FAILING_RUN = [
  "ok     APP_BASE_URL -> APP_BASE_URL",
  "skip   PROGRESS_REPORT_SECRET（値が変わっていません）",
  "FAIL   ZAIM_CONSUMER_KEY（1Passwordから読めません: op://apps/Car/zaim-consumer-key）",
  "FAIL   ZAIM_CONSUMER_SECRET（1Passwordから読めません: op://apps/Car/zaim-consumer-secret）",
  "同期=1 スキップ=1 失敗=2",
];

describe("reusable-sync-secrets の同期ステップ", () => {
  describe("同期スクリプトが失敗したとき（#2049）", () => {
    it("スクリプトの出力（FAIL行と集計）をログへ出す", () => {
      const result = runSyncStep({ lines: FAILING_RUN, exitCode: 1 });

      expect(result.stdout).toContain(
        "FAIL   ZAIM_CONSUMER_KEY（1Passwordから読めません: op://apps/Car/zaim-consumer-key）",
      );
      expect(result.stdout).toContain("同期=1 スキップ=1 失敗=2");
    });

    it("件数と失敗したキー名をGITHUB_OUTPUTへ書く（同期=0 スキップ=0 失敗=0にならない）", () => {
      const result = runSyncStep({ lines: FAILING_RUN, exitCode: 1 });

      expect(result.outputs.synced).toBe("1");
      expect(result.outputs.skipped).toBe("1");
      expect(result.outputs.failed).toBe("2");
      expect(result.outputs.failed_keys).toBe("ZAIM_CONSUMER_KEY,ZAIM_CONSUMER_SECRET");
      expect(result.outputs.synced_keys).toBe("APP_BASE_URL");
      expect(result.outputs.skipped_keys).toBe("PROGRESS_REPORT_SECRET");
      expect(result.outputs.exit_code).toBe("1");
    });

    it("失敗したキー名を注釈（::error::）として出す", () => {
      const result = runSyncStep({ lines: FAILING_RUN, exitCode: 1 });

      expect(result.stdout).toContain(
        "::error::同期に失敗しました（失敗=2 件: ZAIM_CONSUMER_KEY,ZAIM_CONSUMER_SECRET）",
      );
    });

    it("スクリプトの終了コードをそのままステップの結果にする（ジョブは失敗のまま）", () => {
      const result = runSyncStep({ lines: FAILING_RUN, exitCode: 1 });

      expect(result.status).toBe(1);
    });

    it("集計行すら出ないまま落ちた場合も、ログと注釈を出して失敗する", () => {
      const result = runSyncStep({
        lines: ["op: authorization failed"],
        exitCode: 3,
      });

      expect(result.status).toBe(3);
      expect(result.stdout).toContain("op: authorization failed");
      expect(result.stdout).toContain("::error::同期スクリプトが異常終了しました（exit code 3）");
      expect(result.outputs.exit_code).toBe("3");
    });
  });

  describe("同期スクリプトが成功したとき", () => {
    const successRun = [
      "ok     APP_BASE_URL -> APP_BASE_URL",
      "skip   PROGRESS_REPORT_SECRET（値が変わっていません）",
      "同期=1 スキップ=1 失敗=0",
    ];

    it("従来どおり成功で終わり、件数とキー名を返す", () => {
      const result = runSyncStep({ lines: successRun, exitCode: 0 });

      expect(result.status).toBe(0);
      expect(result.outputs.synced).toBe("1");
      expect(result.outputs.failed).toBe("0");
      expect(result.outputs.failed_keys).toBe("");
      expect(result.outputs.exit_code).toBe("0");
      expect(result.summary).toContain("- 同期=1 スキップ=1 失敗=0");
      expect(result.stdout).not.toContain("::error::");
    });

    it("onlyとmanifestを同期スクリプトの引数へ渡す", () => {
      const result = runSyncStep({
        lines: successRun,
        exitCode: 0,
        env: { ONLY: "ZAIM_CONSUMER_KEY", MANIFEST: ".github/secrets-manifest.tsv" },
      });

      expect(result.stdout).toContain(
        "args: --manifest .github/secrets-manifest.tsv --only ZAIM_CONSUMER_KEY",
      );
    });
  });

  it("値も値の長さも出力しない（キー名と理由の文言だけ）", () => {
    const result = runSyncStep({ lines: FAILING_RUN, exitCode: 1 });

    // スクリプトが値を出さない取り決めのため、ここで拾ったものにも値は入らない。
    // 万一の取りこぼしに備え、GITHUB_OUTPUTとサマリにキー名以外が混ざっていないか見る
    for (const key of ["failed_keys", "synced_keys", "skipped_keys"]) {
      expect(result.outputs[key]).toMatch(/^[A-Za-z0-9_]*(,[A-Za-z0-9_]+)*$/);
    }
    expect(result.summary).not.toMatch(/文字|length|bytes/);
  });
});
