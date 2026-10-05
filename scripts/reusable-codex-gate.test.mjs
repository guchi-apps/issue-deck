// `.github/workflows/reusable-claude-review-develop.yml`のCodexレビューまわり（#3990）を、
// GitHub CLIとcurlをスタブに差し替えて実行する。
//
// - 「CodexレビューをサブPCへ依頼する」: 依頼を積んで終わる（結果を待たない）。積めなければ即失敗
// - 「Codexレビューの状態を取得する」: DispatchJobの状態をその場で読み、結果待ち・古いHEAD・
//   失敗・判定ありのどれかを`result`として返す
// - 「マージ保留の判定を反映する」: 結果待ち・古いHEADでは何も反映せず保留し、失敗では
//   自動マージせず人へ渡す（`01.check-blocked`）
//
// **ここが壊れても赤くならない**（判定が保留側・人へ渡す側に倒れるか、最悪は自動マージが通る）ため、
// 分岐ごとに実行して確かめる。

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowYaml = readFileSync(
  path.join(repoRoot, ".github/workflows/reusable-claude-review-develop.yml"),
  "utf8",
);

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

const HEAD = "a".repeat(40);

const STUB_GH = `#!/usr/bin/env bash
set -u
all="$*"
case "$1 $2" in
  "api repos/guchi-apps/issue-deck/pulls/3990") printf '%s' "\${STUB_CURRENT_HEAD:-}"; exit 0 ;;
  "pr view") printf '%s' "\${STUB_PR_COMMENTS:-}"; exit 0 ;;
  "issue view")
    case "$all" in
      *"--json comments"*) printf '%s' "\${STUB_ISSUE_COMMENTS:-}" ;;
      *"--json labels"*) printf '%s' "\${STUB_LABELS:-}" ;;
    esac
    exit 0 ;;
  "label list") printf '00.check-user\\n01.check-merge\\n01.check-blocked\\n'; exit 0 ;;
  "issue edit") echo "EDIT $all" >> "$STUB_LOG"; exit 0 ;;
  "issue comment") echo "COMMENT $all" >> "$STUB_LOG"; exit 0 ;;
esac
exit 0
`;

// -o <file>へ応答を書き、-wの出力（HTTPステータス）を標準出力へ返す。送った本文は記録する
const STUB_CURL = `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2" ;;
    -d) printf '%s\\n' "$2" >> "$STUB_CURL_BODIES" ;;
  esac
  shift
done
[ -z "$out" ] || printf '%s' "\${STUB_API_RESPONSE:-}" > "$out"
printf '%s' "\${STUB_API_CODE:-200}"
`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "codex-gate-"));
  for (const [name, body] of [
    ["gh", STUB_GH],
    ["curl", STUB_CURL],
  ]) {
    writeFileSync(path.join(workDir, name), body);
    chmodSync(path.join(workDir, name), 0o755);
  }
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function baseEnv(extra) {
  const outputPath = path.join(workDir, "output");
  writeFileSync(outputPath, "");
  return {
    outputPath,
    env: {
      ...process.env,
      PATH: `${workDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputPath,
      GH_TOKEN: "dummy",
      GH_REPO: "guchi-apps/issue-deck",
      PR_NUMBER: "3990",
      HEAD_SHA: HEAD,
      STUB_LOG: path.join(workDir, "gh.log"),
      STUB_CURL_BODIES: path.join(workDir, "curl-bodies"),
      ...extra,
    },
  };
}

function parseOutputs(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function status(extra = {}) {
  const { env, outputPath } = baseEnv({
    CODEX_JOB_RESULT: "success",
    APP_BASE_URL: "https://deck.example.com",
    PROGRESS_REPORT_SECRET: "s",
    STUB_CURRENT_HEAD: HEAD,
    ...extra,
  });
  execFileSync("bash", ["-e", "-c", extractRunScript("Codexレビューの状態を取得する")], { env, encoding: "utf8" });
  return parseOutputs(readFileSync(outputPath, "utf8"));
}

function api(state) {
  return { STUB_API_RESPONSE: JSON.stringify(state) };
}

describe("Codexレビューの状態を取得する", () => {
  it("Codexレビューを要求していないrunは skipped", () => {
    expect(status({ CODEX_JOB_RESULT: "skipped" }).result).toBe("skipped");
  });

  it("キュー待ち・実行中は pending（結果を待たずに判定を保留できる）", () => {
    const out = status(api({ state: "pending", message: "サブPCの受け取り待ちです。" }));
    expect(out.result).toBe("pending");
    expect(out.reason).toContain("受け取り待ち");
  });

  it("完了していれば success と判定を返す", () => {
    const out = status(api({ state: "done", verdict: "changes-requested" }));
    expect(out).toMatchObject({ result: "success", verdict: "changes-requested" });
  });

  it("失敗・時間切れは failed と理由を返す（自動マージしない側）", () => {
    const out = status(api({ state: "failed", reason: "サブPCからの応答が途絶えたためタイムアウトしました。" }));
    expect(out.result).toBe("failed");
    expect(out.reason).toContain("タイムアウト");
  });

  it("PRのHEADが進んでいれば、古い結果として stale にする", () => {
    expect(status({ ...api({ state: "done", verdict: "lgtm" }), STUB_CURRENT_HEAD: "b".repeat(40) }).result).toBe("stale");
  });

  it("取り消された（古いHEADの）ジョブは stale", () => {
    expect(status(api({ state: "stale" })).result).toBe("stale");
  });

  it("IssueDeckへ届かなければ failed（結果待ちのまま放置しない）", () => {
    const out = status({ STUB_API_CODE: "503" });
    expect(out.result).toBe("failed");
    expect(out.reason).toContain("HTTP 503");
  });

  it("ジョブが無くても、移行前の実装が残した判定印があればそれを使う（二重に実行しない）", () => {
    const out = status({
      ...api({ state: "missing" }),
      STUB_PR_COMMENTS: `<!-- issue-deck-codex-review-verdict:lgtm sha=${HEAD} -->`,
    });
    expect(out).toMatchObject({ result: "success", verdict: "lgtm" });
  });

  it("ジョブも判定印も無ければ failed", () => {
    expect(status(api({ state: "missing" })).result).toBe("failed");
  });

  it("状態を問い合わせるだけで、レビューを積み直さない", () => {
    status(api({ state: "pending" }));
    const sent = JSON.parse(readFileSync(path.join(workDir, "curl-bodies"), "utf8").trim());
    expect(sent.action).toBe("status");
  });
});

describe("CodexレビューをサブPCへ依頼する", () => {
  function request(extra = {}) {
    const { env, outputPath } = baseEnv({
      BASE_SHA: "c".repeat(40),
      RUN_ID: "123456",
      APP_BASE_URL: "https://deck.example.com",
      PROGRESS_REPORT_SECRET: "s",
      ...api({ state: "pending", message: "サブPCの受け取り待ちです。" }),
      ...extra,
    });
    let exitCode = 0;
    try {
      execFileSync("bash", ["-e", "-c", extractRunScript("CodexレビューをサブPCへ依頼する（結果は待たない）")], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      exitCode = error.status;
    }
    return { exitCode, outputs: parseOutputs(readFileSync(outputPath, "utf8")) };
  }

  it("依頼を積んだら、結果を待たずに成功で終わる", () => {
    const { exitCode } = request();
    expect(exitCode).toBe(0);
    const sent = JSON.parse(readFileSync(path.join(workDir, "curl-bodies"), "utf8").trim());
    expect(sent).toMatchObject({ action: "request", pullRequest: 3990, headSha: HEAD, agent: "codex", runId: "123456" });
  });

  it("実行できるサブPCが無ければ、その場で理由つきで失敗する（30分待たない）", () => {
    const { exitCode, outputs } = request({
      STUB_API_CODE: "409",
      ...api({ message: "PRレビューを実行できるサブPCがありません" }),
    });
    expect(exitCode).toBe(1);
    expect(outputs.reason).toContain("サブPCがありません");
  });

  it("移行前の実装が判定済みなら、依頼しない", () => {
    const { exitCode } = request({ STUB_PR_COMMENTS: `<!-- issue-deck-codex-review-verdict:lgtm sha=${HEAD} -->` });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(workDir, "curl-bodies"))).toBe(false);
  });

  it("結果を待つループを持たない", () => {
    const script = extractRunScript("CodexレビューをサブPCへ依頼する（結果は待たない）");
    expect(script).not.toMatch(/sleep|seq 1/);
  });
});

describe("マージ保留の判定を反映する（Codexの結果）", () => {
  function hold(codexResult, extra = {}) {
    const { env, outputPath } = baseEnv({
      ISSUE_NUMBER: "3990",
      RISKY: "false",
      REASONS: "",
      ALREADY_CHECK_USER: "false",
      REVIEW_RESULT: "skipped",
      CODEX_REVIEW_RESULT: codexResult,
      REVIEW_AUTO_FIX: "true",
      ...extra,
    });
    execFileSync("bash", ["-e", "-c", extractRunScript("マージ保留の判定を反映する")], { env, encoding: "utf8" });
    const logPath = path.join(workDir, "gh.log");
    return {
      outputs: parseOutputs(readFileSync(outputPath, "utf8")),
      log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
    };
  }

  it("結果待ち・古いHEADでは何も反映せず、待機中の印だけを残す", () => {
    for (const result of ["pending", "stale"]) {
      const { outputs, log } = hold(result, { RISKY: "true", REASONS: "- x" });
      expect(outputs.waiting).toBe("true");
      expect(log).toBe("");
    }
  });

  it("失敗は自動マージせず、01.check-blockedで人へ渡す", () => {
    const { outputs, log } = hold("failed", { CODEX_FAILURE_REASON: "サブPCからの応答が途絶えたためタイムアウトしました。" });
    expect(outputs.waiting).toBeUndefined();
    expect(log).toContain("--add-label 00.check-user");
    expect(log).toContain("--add-label 01.check-blocked");
    expect(log).toContain("完了できなかった");
    expect(log).toContain("タイムアウト");
  });

  it("要修正の判定は01.check-mergeで人へ渡す", () => {
    const { log } = hold("success", { CODEX_VERDICT_INPUT: "changes-requested" });
    expect(log).toContain("--add-label 01.check-merge");
    expect(log).toContain("changes-requested");
  });

  it("問題なしなら何も付けない", () => {
    expect(hold("success", { CODEX_VERDICT_INPUT: "lgtm" }).log).toBe("");
  });
});
