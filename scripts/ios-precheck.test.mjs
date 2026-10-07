// iOS事前検証（`scripts/ios-precheck.sh`と`scripts/lib/ios-precheck-remote.sh`）の契約を固定する（#4138）。
//
// **Macを使わずに、依頼側とMac側の両方を本物のまま動かす。** `ssh`は「最後の引数をそのまま
// `bash -c`で実行する」偽物に差し替え、Mac側の`HOME`を一時ディレクトリへ向ける。`xcodebuild`・
// `xcrun`は振る舞いを環境変数で切り替える偽物を置く。`git archive`→`git get-tar-commit-id`・
// nohupでの切り離し・ロック・タイムアウトでの停止は実物が動く。
//
// 見張っていること:
// - 未設定のリポジトリ・接続不可・環境不足・タイムアウトを**成功にも検証失敗にもしない**
// - ビルドとテストの成否を別々に返し、テスト未設定・0件を成功と区別する
// - 検証したSHAをtarから読み直したものとして返す
// - 同じジョブIDの再送で二重に走らせず、別SHAの同時依頼はMac単位で1件ずつ走らせる
// - 修正の試行回数に上限があり、環境の問題ではソースの修正を促さない
// - commit statusは成功・失敗をMacの結果からだけ出し、接続不可はpendingのままにする

import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/ios-precheck.sh");

let work;
let env;

function writeExecutable(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function commit(message) {
  writeFileSync(path.join(work, "app", "change.txt"), `${message}\n`);
  git(path.join(work, "app"), "add", "-A");
  git(path.join(work, "app"), "commit", "-q", "-m", message);
  return git(path.join(work, "app"), "rev-parse", "HEAD");
}

function writeConfig(extra = "") {
  writeFileSync(
    path.join(work, "ios-precheck.conf"),
    [
      "# テスト用",
      "[test-owner/app]",
      "project=ios/App.xcodeproj",
      "scheme=App",
      "simulator=iPhone 17",
      "tests=none",
      "kind=build",
      "required=true",
      extra,
    ].join("\n"),
  );
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "ios-precheck-"));
  const bin = path.join(work, "bin");
  const macHome = path.join(work, "mac-home");
  mkdirSync(bin);
  mkdirSync(macHome);

  // 対象リポジトリ（サブPC側のチェックアウト）
  const app = path.join(work, "app");
  mkdirSync(path.join(app, "ios", "App.xcodeproj"), { recursive: true });
  writeFileSync(path.join(app, "ios", "App.xcodeproj", "project.pbxproj"), "// fake\n");
  execFileSync("git", ["init", "-q", "-b", "issue-1", app]);
  git(app, "remote", "add", "origin", "https://github.com/test-owner/app.git");
  commit("init");

  // ssh: オプションとホストを読み捨て、最後の引数をMac側のHOMEで実行する
  writeExecutable(
    path.join(bin, "fake-ssh"),
    `#!/usr/bin/env bash
if [ -n "\${FAKE_SSH_FAIL:-}" ]; then
  echo "ssh: connect to host mac port 22: Connection refused" >&2
  exit 255
fi
# 状態の取得だけを落とす（依頼の後でSSHが切れた形）
if [ -n "\${FAKE_SSH_FAIL_STATUS:-}" ] && [[ "\${@: -1}" == *" status "* ]]; then
  echo "Connection to mac closed by remote host." >&2
  exit 255
fi
HOME="${macHome}" exec bash -c "\${@: -1}"
`,
  );
  // xcodebuild: 呼ばれた引数を記録し、FAKE_XCODE_MODEで結果を変える
  writeExecutable(
    path.join(bin, "xcodebuild"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-version" ]; then printf 'Xcode 99.0\\nBuild version 99A1\\n'; exit 0; fi
action="\${@: -1}"
printf '%s %s start %s\\n' "$(date +%s.%N)" "$action" "$$" >> "${work}/xcodebuild-calls.log"
mode="\${FAKE_XCODE_MODE:-ok}"
for a in "$@"; do
  if [ "$prev" = "-resultBundlePath" ]; then mkdir -p "$a"; fi
  prev="$a"
done
case "$action:$mode" in
  build*:build_fail) echo "App.swift:3:1: error: cannot find 'foo' in scope"; echo "** BUILD FAILED **"; exit 65 ;;
  build*:env_fail) echo "xcodebuild: error: Unable to find a destination matching the provided destination specifier"; exit 70 ;;
  build*:hang) sleep 60 ;;
  test-without-building:test_fail) echo "Test Case '-[AppTests testA]' failed"; exit 65 ;;
esac
sleep "\${FAKE_XCODE_SLEEP:-0}"
printf '%s %s end %s\\n' "$(date +%s.%N)" "$action" "$$" >> "${work}/xcodebuild-calls.log"
echo "** SUCCEEDED **"
`,
  );
  writeExecutable(
    path.join(bin, "xcrun"),
    `#!/usr/bin/env bash
case "$*" in
  "simctl list devices available") printf -- '== Devices ==\\n-- iOS 27.0 --\\n    iPhone 17 (0000-1111) (Shutdown) \\n' ;;
  "simctl list runtimes") printf 'iOS 27.0 (27.0 - 24A1) - com.apple.CoreSimulator.SimRuntime.iOS-27-0\\n' ;;
  xcresulttool*) printf '%s' "\${FAKE_TEST_SUMMARY:-}"; [ -n "\${FAKE_TEST_SUMMARY:-}" ] ;;
  *) exit 1 ;;
esac
`,
  );
  // gh: commit statusの投稿だけを記録する
  writeExecutable(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${work}/gh-calls.log"
`,
  );

  writeConfig();
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    IOS_PRECHECK_SSH: path.join(bin, "fake-ssh"),
    IOS_PRECHECK_HOST: "mac",
    IOS_PRECHECK_POLL_INTERVAL: "1",
    IOS_PRECHECK_MAX_POLL_FAILURES: "2",
    ISSUE_DECK_IOS_PRECHECK_CONFIG: path.join(work, "ios-precheck.conf"),
    ISSUE_DECK_IOS_PRECHECK_STATE: path.join(work, "state"),
    ISSUE_DECK_IOS_PRECHECK_ENV: path.join(work, "missing.env"),
  };
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 1回実行して、終了コードと標準出力のJSONを返す */
function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [script, ...args],
      { cwd: path.join(work, "app"), env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "null";
        resolve({ code, json: JSON.parse(line), stderr });
      },
    );
  });
}

function ghCalls() {
  const file = path.join(work, "gh-calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

function xcodeCalls() {
  const file = path.join(work, "xcodebuild-calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

describe("ios-precheck.sh run", { timeout: 40_000 }, () => {
  it("設定の無いリポジトリは未設定の検証待ちで返し、Macへ接続もstatusの投稿もしない", async () => {
    writeFileSync(path.join(work, "ios-precheck.conf"), "[other/repo]\nproject=x\n");
    const { code, json } = await run(["run"]);
    expect(code).toBe(2);
    expect(json.state).toBe("waiting");
    expect(json.waitingReason).toBe("not_configured");
    expect(json.client.nextAction).toBe("not_configured");
    expect(ghCalls()).toEqual([]);
    expect(xcodeCalls()).toEqual([]);
  });

  it("ビルドが通れば成功を返し、検証したSHAはtarから読み直した値になる", async () => {
    const sha = git(path.join(work, "app"), "rev-parse", "HEAD");
    const { code, json } = await run(["run"]);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      state: "succeeded",
      repository: "test-owner/app",
      requestedSha: sha,
      verifiedSha: sha,
      jobId: `app-${sha.slice(0, 12)}-build`,
      build: { status: "passed", exitCode: 0 },
      test: { status: "not_requested" },
      environment: { xcode: "Xcode 99.0 Build version 99A1" },
      client: { branch: "issue-1", required: true, nextAction: "proceed" },
    });
    expect(json.environment.simulator).toContain("iPhone 17");
    expect(json.artifacts.buildResult).toMatch(/build\.xcresult$/);
    // pendingで始まり、最後にsuccessをそのSHAへ付ける
    const calls = ghCalls();
    expect(calls[0]).toContain(`repos/test-owner/app/statuses/${sha}`);
    expect(calls[0]).toContain("state=pending");
    expect(calls.at(-1)).toContain("state=success");
    expect(calls.every((c) => c.includes("context=issue-deck/ios-precheck"))).toBe(true);
  });

  it("テスト未設定のアプリにテストを依頼しても、テスト成功とは返さない", async () => {
    const { code, json } = await run(["run", "--kind", "test"]);
    expect(code).toBe(0);
    expect(json.build.status).toBe("passed");
    expect(json.test.status).toBe("not_configured");
    expect(json.message).toContain("自動テストが設定されていません");
  });

  it("テストを設定した対象では、xcresultから件数を読んで返す", async () => {
    writeConfig("tests=scheme");
    const { code, json } = await run(["run", "--kind", "test"], {
      FAKE_TEST_SUMMARY: JSON.stringify({ totalTestCount: 5, passedTests: 4, failedTests: 0, skippedTests: 1 }),
    });
    expect(code).toBe(0);
    expect(json.test).toEqual({ status: "passed", exitCode: 0, total: 5, passed: 4, failed: 0, skipped: 1 });
    expect(xcodeCalls().map((l) => l.split(" ")[1])).toEqual([
      "build-for-testing",
      "build-for-testing",
      "test-without-building",
      "test-without-building",
    ]);
  });

  it("テストが0件なら成功にしない", async () => {
    writeConfig("tests=scheme");
    const { code, json } = await run(["run", "--kind", "test"], {
      FAKE_TEST_SUMMARY: JSON.stringify({ totalTestCount: 0, passedTests: 0, failedTests: 0, skippedTests: 0 }),
    });
    expect(code).toBe(1);
    expect(json.state).toBe("failed");
    expect(json.test.status).toBe("zero_tests");
  });

  it("テスト失敗はビルド成功と分けて返す", async () => {
    writeConfig("tests=scheme");
    const { code, json } = await run(["run", "--kind", "test"], {
      FAKE_XCODE_MODE: "test_fail",
      FAKE_TEST_SUMMARY: JSON.stringify({ totalTestCount: 3, passedTests: 2, failedTests: 1, skippedTests: 0 }),
    });
    expect(code).toBe(1);
    expect(json).toMatchObject({
      state: "failed",
      failedStage: "test",
      build: { status: "passed" },
      test: { status: "failed", total: 3, failed: 1 },
    });
  });

  it("ビルド失敗は検証失敗として返し、ログの抜粋を出す。同じブランチで上限まで失敗したら修正をやめさせる", async () => {
    const first = await run(["run"], { FAKE_XCODE_MODE: "build_fail" });
    expect(first.code).toBe(1);
    expect(first.json).toMatchObject({ state: "failed", failedStage: "build", build: { status: "failed", exitCode: 65 } });
    expect(first.json.client).toMatchObject({ nextAction: "fix_and_recheck", fixAttempts: 1, maxFixAttempts: 3 });
    expect(first.stderr).toContain("cannot find 'foo' in scope");
    expect(ghCalls().at(-1)).toContain("state=failure");

    commit("fix 1");
    await run(["run"], { FAKE_XCODE_MODE: "build_fail" });
    commit("fix 2");
    const third = await run(["run"], { FAKE_XCODE_MODE: "build_fail" });
    expect(third.json.client).toMatchObject({ nextAction: "stop_fix_limit", fixAttempts: 3 });

    // 修正コミットで通れば、そのSHAの成功として返る
    const fixedSha = commit("fix 3");
    const fixed = await run(["run"]);
    expect(fixed.code).toBe(0);
    expect(fixed.json.verifiedSha).toBe(fixedSha);
    expect(fixed.json.client.nextAction).toBe("proceed");
  });

  it("Macの環境が原因の失敗は検証失敗にせず、環境の解消を促す", async () => {
    const { code, json } = await run(["run"], { FAKE_XCODE_MODE: "env_fail" });
    expect(code).toBe(2);
    expect(json).toMatchObject({ state: "waiting", waitingReason: "environment", build: { status: "not_run" } });
    expect(json.client.nextAction).toBe("resolve_environment");
    expect(ghCalls().at(-1)).toContain("state=pending");
  });

  it("タイムアウトは成功にも失敗にもせず、そのジョブのプロセスだけを止める", async () => {
    writeConfig("build_timeout=2");
    const { code, json } = await run(["run"], { FAKE_XCODE_MODE: "hang" });
    expect(code).toBe(2);
    expect(json).toMatchObject({ state: "waiting", waitingReason: "timeout", build: { status: "timeout" } });
    expect(json.client.nextAction).toBe("retry_or_report");
  });

  it("Macに接続できなければ理由付きの検証待ちにし、statusはpendingのままにする", async () => {
    const { code, json } = await run(["run"], { FAKE_SSH_FAIL: "1" });
    expect(code).toBe(2);
    expect(json).toMatchObject({ state: "waiting", waitingReason: "unreachable" });
    expect(json.client.nextAction).toBe("resolve_environment");
    expect(ghCalls().every((c) => c.includes("state=pending"))).toBe(true);
  });

  it("依頼の後でSSHが切れたら切断として返し、Mac側で走り続けたジョブへ再接続できる", async () => {
    const lost = await run(["run"], { FAKE_SSH_FAIL_STATUS: "1", FAKE_XCODE_SLEEP: "1" });
    expect(lost.code).toBe(2);
    expect(lost.json).toMatchObject({ state: "waiting", waitingReason: "disconnected" });
    expect(lost.json.client.nextAction).toBe("resume");
    expect(lost.json.client.resumeCommand).toContain(`status --job ${lost.json.jobId}`);
    expect(ghCalls().every((c) => c.includes("state=pending"))).toBe(true);

    const resumed = await run(["status", "--job", lost.json.jobId, "--wait"]);
    expect(resumed.code).toBe(0);
    expect(resumed.json.state).toBe("succeeded");
    expect(ghCalls().at(-1)).toContain("state=success");
  });

  it("接続先が未設定なら、設定場所を示して検証待ちにする", async () => {
    const { code, json } = await run(["run"], { IOS_PRECHECK_HOST: "" });
    expect(code).toBe(2);
    expect(json.waitingReason).toBe("environment");
    expect(json.message).toContain("IOS_PRECHECK_HOST");
  });

  it("同じSHAの再送は二重に実行せず、--retryのときだけやり直す", async () => {
    const first = await run(["run"]);
    const second = await run(["run"]);
    expect(second.json.jobId).toBe(first.json.jobId);
    expect(second.json.state).toBe("succeeded");
    expect(second.stderr).toContain("同じジョブIDの依頼が既にあります");
    expect(xcodeCalls().filter((l) => l.includes(" start "))).toHaveLength(1);

    const retried = await run(["run", "--retry"]);
    expect(retried.json.jobId).not.toBe(first.json.jobId);
    expect(xcodeCalls().filter((l) => l.includes(" start "))).toHaveLength(2);
  });

  it("別SHAの同時依頼はMac単位で1件ずつ実行する", async () => {
    const shaA = git(path.join(work, "app"), "rev-parse", "HEAD");
    const shaB = commit("second");
    const [a, b] = await Promise.all([
      run(["run", "--sha", shaA], { FAKE_XCODE_SLEEP: "2" }),
      run(["run", "--sha", shaB], { FAKE_XCODE_SLEEP: "2" }),
    ]);
    expect(a.json.state).toBe("succeeded");
    expect(b.json.state).toBe("succeeded");
    expect(a.json.verifiedSha).toBe(shaA);
    expect(b.json.verifiedSha).toBe(shaB);
    // start/endが交互に並ぶ（重なっていない）
    const events = xcodeCalls()
      .map((l) => l.split(" "))
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map((p) => p[2]);
    expect(events).toEqual(["start", "end", "start", "end"]);
  });

  it("--no-waitで依頼だけして、status --job --waitで再接続して結果を受け取れる", async () => {
    const submitted = await run(["run", "--no-wait"], { FAKE_XCODE_SLEEP: "2" });
    expect(submitted.code).toBe(2);
    expect(submitted.json.state).toBe("queued");
    expect(submitted.json.client.resumeCommand).toContain(`status --job ${submitted.json.jobId}`);
    const resumed = await run(["status", "--job", submitted.json.jobId, "--wait"]);
    expect(resumed.code).toBe(0);
    expect(resumed.json.state).toBe("succeeded");
    expect(resumed.json.client.branch).toBe("issue-1");
  });
});

describe("ios-precheck.sh config", { timeout: 20_000 }, () => {
  it("設定の誤りを列挙し、configuredをfalseにする", async () => {
    writeConfig("tests=maybe");
    const { code, json } = await run(["config"]);
    expect(code).not.toBe(0);
    expect(json.configured).toBe(false);
    expect(json.problems.join("\n")).toContain("tests は none か scheme です");
  });

  it("正しい設定はそのまま返す", async () => {
    const { code, json } = await run(["config", "--repo", "test-owner/app"]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ configured: true, project: "ios/App.xcodeproj", scheme: "App", required: true });
  });
});
