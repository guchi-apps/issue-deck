import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Job Summaryの「権限拒否されたツール」がtool_name単独でuniqしていたため、Bashの拒否が
// 何件あっても「Bash」の1語にしかならず、診断に使えなかった（#1166）。
// 実際にguchi-apps/issue-deck#931で21件の拒否を分析する際、Job Summaryからは内訳が読めず、
// 生の実行ログをダウンロードしてpermission_denialsを掘る必要があった。
const SCRIPT = join(process.cwd(), ".github", "scripts", "summarize-claude-usage.sh");

function runScript(executionFileContent: string): { exitCode: number; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), "summarize-claude-usage-"));
  const executionFile = join(dir, "execution.json");
  const summaryFile = join(dir, "summary.md");
  writeFileSync(executionFile, executionFileContent);

  let exitCode = 0;
  try {
    execFileSync("bash", [SCRIPT, "テストステップ", executionFile], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
      encoding: "utf8",
    });
  } catch (error) {
    exitCode = (error as { status: number }).status;
  }

  const summary = readFileSync(summaryFile, "utf8");
  return { exitCode, summary };
}

function resultExecutionFile(result: Record<string, unknown>): string {
  return JSON.stringify([{ type: "result", ...result }]);
}

// resultターンにモデル名は含まれないため、assistantターンからmessage.modelを拾う（#3555）。
function executionFileWithModels(models: Array<string | null>, result: Record<string, unknown>): string {
  const assistantRecords = models.map((model) => ({ type: "assistant", message: { model } }));
  return JSON.stringify([...assistantRecords, { type: "result", ...result }]);
}

// report_to_issue_deckが実際に送る本文を、curlをスタブして捕捉する。
function runScriptWithReport(
  executionFileContent: string,
  env: Record<string, string> = {},
): { exitCode: number; summary: string; reportBody: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "summarize-claude-usage-"));
  const executionFile = join(dir, "execution.json");
  const summaryFile = join(dir, "summary.md");
  const captureFile = join(dir, "curl-capture.json");
  writeFileSync(executionFile, executionFileContent);

  const stubBinDir = join(dir, "bin");
  mkdirSync(stubBinDir);
  const curlStubPath = join(stubBinDir, "curl");
  writeFileSync(
    curlStubPath,
    [
      "#!/usr/bin/env bash",
      'for ((i=1; i<=$#; i++)); do',
      '  if [ "${!i}" = "--data-binary" ]; then',
      "    j=$((i+1))",
      '    printf \'%s\' "${!j}" > "$CURL_CAPTURE_FILE"',
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(curlStubPath, 0o755);

  let exitCode = 0;
  try {
    execFileSync("bash", [SCRIPT, "テストステップ", executionFile], {
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryFile,
        PATH: `${stubBinDir}:${process.env.PATH}`,
        CURL_CAPTURE_FILE: captureFile,
        ...env,
      },
      encoding: "utf8",
    });
  } catch (error) {
    exitCode = (error as { status: number }).status;
  }

  const summary = readFileSync(summaryFile, "utf8");
  let reportBody: string | null = null;
  try {
    reportBody = readFileSync(captureFile, "utf8");
  } catch {
    reportBody = null;
  }
  return { exitCode, summary, reportBody };
}

describe("summarize-claude-usage.sh の権限拒否集計", () => {
  it("permission_denialsが空のとき、警告行を出さない", () => {
    const { exitCode, summary } = runScript(resultExecutionFile({ permission_denials: [] }));

    expect(exitCode).toBe(0);
    expect(summary).not.toContain("権限拒否");
  });

  it("permission_denialsが無いフィールド自体のとき、警告行を出さない", () => {
    const { exitCode, summary } = runScript(resultExecutionFile({}));

    expect(exitCode).toBe(0);
    expect(summary).not.toContain("権限拒否");
  });

  it("同じコマンドが複数回拒否されたとき、件数がまとまり降順で並ぶ", () => {
    const { exitCode, summary } = runScript(
      resultExecutionFile({
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "corepack --version" } },
          { tool_name: "Bash", tool_input: { command: "corepack --version" } },
          { tool_name: "Bash", tool_input: { command: "corepack --version" } },
          { tool_name: "Bash", tool_input: { command: "mkdir -p /tmp/x" } },
          { tool_name: "WebFetch" },
        ],
      }),
    );

    expect(exitCode).toBe(0);
    expect(summary).toContain("⚠️ **権限拒否**: 5件");

    const lines = summary.split("\n");
    const corepackLine = lines.findIndex((line) => line.includes("corepack --version"));
    const mkdirLine = lines.findIndex((line) => line.includes("mkdir -p /tmp/x"));
    const webFetchLine = lines.findIndex((line) => line.includes("WebFetch"));

    expect(corepackLine).toBeGreaterThan(-1);
    expect(mkdirLine).toBeGreaterThan(-1);
    expect(webFetchLine).toBeGreaterThan(-1);
    expect(lines[corepackLine]).toContain("| 3 |");
    // 件数の多い順に並ぶため、3件のcorepackが1件のものより先に出る
    expect(corepackLine).toBeLessThan(mkdirLine);
    expect(corepackLine).toBeLessThan(webFetchLine);
  });

  it("長いコマンド・改行を含むコマンドが表を壊さない", () => {
    const longCommand = `echo ${"a".repeat(200)}`;
    const multilineCommand = "mkdir -p /tmp/x\ncurl -sL -o /tmp/x/img.jpg url";

    const { exitCode, summary } = runScript(
      resultExecutionFile({
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: longCommand } },
          { tool_name: "Bash", tool_input: { command: multilineCommand } },
        ],
      }),
    );

    expect(exitCode).toBe(0);

    const lines = summary.split("\n");
    const headerIndex = lines.indexOf("| 回数 | コマンド |");
    expect(headerIndex).toBeGreaterThan(-1);
    // ヘッダーの次の区切り行から、空行に達するまでがデータ行
    const dataLines = lines
      .slice(headerIndex + 2)
      .filter((line) => line.length > 0 && line.startsWith("|"));
    // データ2行のみで、途中で改行が挟まって行が増えていないこと
    expect(dataLines).toHaveLength(2);
    for (const line of dataLines) {
      expect(line.split("|")).toHaveLength(4); // "| a | b |" は空・a・b・空の4要素に割れる
    }

    const longLine = dataLines.find((line) => line.includes("aaa"));
    expect(longLine).toBeDefined();
    // 80文字程度に切り詰められている（末尾の省略記号込みでコマンド本体が大きく超えない）
    expect((longLine as string).length).toBeLessThan(longCommand.length);
  });

  it("execution_fileが壊れたJSONでもexit 0する", () => {
    const { exitCode, summary } = runScript("{not valid json");

    expect(exitCode).toBe(0);
    expect(summary).not.toContain("権限拒否");
    expect(summary).toContain("Claude使用量");
  });

  it("既存の出力（トークン・ターン数・所要時間）は変えない", () => {
    const { summary } = runScript(
      resultExecutionFile({
        total_cost_usd: 1.2345,
        num_turns: 5,
        duration_ms: 12345,
        duration_api_ms: 6789,
        subtype: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 400,
        },
      }),
    );

    expect(summary).toContain("$1.2345");
    expect(summary).toContain("| ターン数 | 5 |");
    expect(summary).toContain("12秒");
    expect(summary).toContain("7秒");
    expect(summary).toContain("200");
    expect(summary).toContain("100");
    expect(summary).toContain("300");
    expect(summary).toContain("400");
    expect(summary).toContain("success");
  });
});

describe("summarize-claude-usage.sh のモデル集計・報告（#3555）", () => {
  const REPORT_ENV = {
    AI_USAGE_REPORT_URL: "http://example.invalid/report",
    PROGRESS_REPORT_SECRET: "secret",
    GITHUB_REPOSITORY: "guchi-apps/issue-deck",
    GITHUB_RUN_ID: "123",
  };

  it("複数assistantターンのmessage.modelを重複除去して報告する", () => {
    const executionFile = executionFileWithModels(
      ["claude-sonnet-5", "claude-sonnet-5", "claude-opus-5-5"],
      { total_cost_usd: 1.5 },
    );

    const { reportBody } = runScriptWithReport(executionFile, REPORT_ENV);

    expect(reportBody).not.toBeNull();
    const payload = JSON.parse(reportBody as string);
    expect(payload.reports[0].models).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("message.modelが無い・空のassistantターンは無視する", () => {
    const executionFile = executionFileWithModels([null, "", "claude-sonnet-5"], { total_cost_usd: 0.5 });

    const { reportBody } = runScriptWithReport(executionFile, REPORT_ENV);

    const payload = JSON.parse(reportBody as string);
    expect(payload.reports[0].models).toEqual(["claude-sonnet-5"]);
  });

  it("assistantターンが無ければ空配列のまま報告する", () => {
    const executionFile = resultExecutionFile({ total_cost_usd: 0.1 });

    const { reportBody } = runScriptWithReport(executionFile, REPORT_ENV);

    const payload = JSON.parse(reportBody as string);
    expect(payload.reports[0].models).toEqual([]);
  });

  it("報告先の環境変数が揃わなければ報告自体を行わない", () => {
    const executionFile = executionFileWithModels(["claude-sonnet-5"], { total_cost_usd: 0.5 });

    const { reportBody, exitCode } = runScriptWithReport(executionFile);

    expect(exitCode).toBe(0);
    expect(reportBody).toBeNull();
  });
});
