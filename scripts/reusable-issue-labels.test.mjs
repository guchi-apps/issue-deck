// `.github/workflows/reusable-issue-labels.yml`のシェル判定を、GitHub CLIとcurlを
// スタブに差し替えて実行する（#1861）。
//
// このワークフローは進捗（Project Status）の唯一の遷移経路でありながら、判定はすべて
// `run:`のbashにある。**#1583では`gh label list`のHTTP 503でステップごと落ち、後続の
// 進捗報告までスキップされてissueが`Implementation`のまま取り残された。** 失敗経路は
// 実際に走らせないと確かめられないため、YAMLから`run:`本文を取り出してそのまま実行する。
//
// GitHub Actionsの既定シェル（`bash -e {0}`）に合わせて`bash -e`で起動する。-eの下では
// コマンド1つの失敗がステップ全体の異常終了になるため、この起動方法自体がテストの一部。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/reusable-issue-labels.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

/**
 * ステップ名から`run: |`の本文を取り出す。YAMLパーサを足さずに済ませるための最小実装で、
 * このファイルが対象にするワークフローの書き方（`- name:`の直後のステップ定義に`run: |`が
 * ブロックスカラーで続く）だけを想定する。
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

const STUB_GH = `#!/usr/bin/env bash
set -u
echo "gh $*" >> "$STUB_LOG"
case "$1 \${2:-}" in
  "label list")
    if [ "\${STUB_LABEL_LIST_FAIL:-0}" = "1" ]; then
      echo "gh: No server is currently available to service your request. (HTTP 503)" >&2
      exit 1
    fi
    printf '%s\\n' 00.check-user 01.check-merge 01.check-blocked 30.bug
    ;;
  "pr list")
    head=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--head" ]; then head="$2"; fi
      shift
    done
    var="STUB_PR_\${head#issue-}"
    value="\${!var:-}"
    if [ -z "$value" ]; then echo "[]"
    elif [ "$value" = "fail" ]; then echo "gh: server error (HTTP 502)" >&2; exit 1
    else echo "$value"; fi
    ;;
  "api repos"*)
    var="STUB_REF_\${2##*/issue-}"
    value="\${!var:-404}"
    if [ "$value" = "404" ]; then echo '{"message":"Not Found","status":"404"}'; exit 1
    elif [ "$value" = "fail" ]; then echo "gh: server error" >&2; exit 1
    else echo "{\\"object\\":{\\"sha\\":\\"$value\\"}}"; fi
    ;;
  "issue view")
    var="STUB_COMMENTS_$3"
    value="\${!var:-}"
    if [ -z "$value" ]; then echo '{"comments":[]}'; else echo "$value"; fi
    ;;
  "issue edit"|"issue comment"|"issue close")
    if [ "\${STUB_ISSUE_WRITE_FAIL:-0}" = "1" ]; then
      echo "gh: server error (HTTP 500)" >&2
      exit 1
    fi
    ;;
  *)
    echo "gh stub: unhandled: $*" >&2
    exit 1
    ;;
esac
`;

const STUB_CURL = `#!/usr/bin/env bash
set -u
echo "curl $*" >> "$STUB_LOG"
out=""
method="GET"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -X) method="$2"; shift ;;
  esac
  shift
done
if [ "$method" = "POST" ]; then
  codes_file="$STUB_LOG.postcodes"
  if [ ! -f "$codes_file" ]; then printf '%s\\n' \${STUB_POST_CODES:-200} > "$codes_file"; fi
  code="$(head -n1 "$codes_file")"
  tail -n +2 "$codes_file" > "$codes_file.tmp" && mv "$codes_file.tmp" "$codes_file"
  [ -n "$code" ] || code=200
  [ -z "$out" ] || : > "$out"
  printf '%s' "$code"
  exit 0
fi
[ -z "$out" ] || printf '%s' "\${STUB_PROGRESS_BODY:-}" > "$out"
printf '%s' "\${STUB_GET_CODE:-200}"
`;

// 再試行の待ち時間でテストを止めない。何秒待とうとしたかはログで確かめる
const STUB_SLEEP = `#!/usr/bin/env bash
echo "sleep $*" >> "$STUB_LOG"
`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "issue-labels-test-"));
  const stubDir = path.join(workDir, "stub");
  execFileSync("mkdir", ["-p", stubDir]);
  for (const [name, content] of [
    ["gh", STUB_GH],
    ["curl", STUB_CURL],
    ["sleep", STUB_SLEEP],
  ]) {
    const file = path.join(stubDir, name);
    writeFileSync(file, content);
    chmodSync(file, 0o755);
  }
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** ステップを1回実行し、標準出力・GITHUB_OUTPUT・スタブの呼び出しログを返す */
function runStep(stepName, env = {}) {
  const script = path.join(workDir, "step.sh");
  writeFileSync(script, extractRunScript(stepName));
  const outputFile = path.join(workDir, "github_output.txt");
  const logFile = path.join(workDir, "calls.log");
  writeFileSync(outputFile, "");
  writeFileSync(logFile, "");

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${path.join(workDir, "stub")}:/usr/bin:/bin`,
        STUB_LOG: logFile,
        GITHUB_OUTPUT: outputFile,
        RUNNER_TEMP: workDir,
        APP_BASE_URL: "https://issue-deck.example.test",
        PROGRESS_REPORT_SECRET: "dummy",
        REPO: "guchi-apps/issue-deck",
        GH_REPO: "guchi-apps/issue-deck",
        RUN_URL: "https://example.test/run",
        PR_URL: "https://example.test/pull/1857",
        ...env,
      },
    });
  } catch (error) {
    status = error.status ?? 1;
    stdout = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const output = readFileSync(outputFile, "utf8");
  const block = output.match(/issue_numbers<<TRANSITIONED_EOF\n([\s\S]*?)TRANSITIONED_EOF/);
  const single = output.match(/^issue_numbers=(.*)$/m);
  const reported = block
    ? block[1].split("\n").filter(Boolean)
    : single
      ? [single[1]]
      : [];

  return { status, stdout, reported, calls: readFileSync(logFile, "utf8") };
}

const MERGED_PR = JSON.stringify([
  {
    headRefOid: "aaa111",
    mergedAt: "2026-08-17T17:13:06Z",
    url: "https://github.com/guchi-apps/issue-deck/pull/1857",
  },
]);

const SWEEP_STEP = "マージ済みのdevelop向けPRを持つissueをDevelopへ進める";

describe("develop-merge-sweep", () => {
  const inImplementation = {
    STUB_PROGRESS_BODY: '{"ok":true,"available":true,"issues":[1583]}',
  };

  it("Implementationのままマージ済みのissueをDevelopへ進める（#1583の取り残し）", () => {
    const result = runStep(SWEEP_STEP, { ...inImplementation, STUB_PR_1583: MERGED_PR });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1583"]);
    expect(result.calls).toContain("gh issue comment 1583");
    // `Develop PR`だけでなく`Implementation`も問い合わせている
    expect(result.calls).toContain("status=develop-pr,implementation");
  });

  it("マージ後に追加pushがあるブランチは進めない（mode=additionalの実装中）", () => {
    const result = runStep(SWEEP_STEP, {
      ...inImplementation,
      STUB_PR_1583: MERGED_PR,
      STUB_REF_1583: "bbb222",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual([]);
    expect(result.calls).not.toContain("gh issue comment");
  });

  it("ブランチが残っていて先端が一致するなら進める", () => {
    const result = runStep(SWEEP_STEP, {
      ...inImplementation,
      STUB_PR_1583: MERGED_PR,
      STUB_REF_1583: "aaa111",
    });

    expect(result.reported).toEqual(["1583"]);
  });

  it("ブランチの状態を確認できないときは進めず、次回のcronに回す", () => {
    const result = runStep(SWEEP_STEP, {
      ...inImplementation,
      STUB_PR_1583: MERGED_PR,
      STUB_REF_1583: "fail",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual([]);
    expect(result.stdout).toContain("次回のスケジュール実行で再判定します");
  });

  it("PR一覧の取得失敗を「マージ済みPRなし」と取り違えない", () => {
    const result = runStep(SWEEP_STEP, { ...inImplementation, STUB_PR_1583: "fail" });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual([]);
    expect(result.stdout).toContain("マージ済みPRを取得できませんでした");
  });

  it("ラベル一覧がHTTP 503でも落ちず、進捗の報告まで進む", () => {
    const result = runStep(SWEEP_STEP, {
      ...inImplementation,
      STUB_PR_1583: MERGED_PR,
      STUB_LABEL_LIST_FAIL: "1",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1583"]);
    expect(result.stdout).toContain("ラベル一覧を取得できませんでした");
  });

  it("同じPRのマージを通知済みなら、コメントを重ねない", () => {
    const result = runStep(SWEEP_STEP, {
      ...inImplementation,
      STUB_PR_1583: MERGED_PR,
      STUB_COMMENTS_1583: JSON.stringify({
        comments: [
          {
            body: "✅ developへのマージが完了しました: https://github.com/guchi-apps/issue-deck/pull/1857",
          },
        ],
      }),
    });

    expect(result.reported).toEqual(["1583"]);
    expect(result.calls).not.toContain("gh issue comment");
  });

  it("マージ済みPRが無いissueには何もしない", () => {
    const result = runStep(SWEEP_STEP, inImplementation);

    expect(result.status).toBe(0);
    expect(result.reported).toEqual([]);
  });
});

describe("develop-pr-merged / develop-pr-opened の通知ステップ", () => {
  it("ラベル一覧がHTTP 503でも、進捗報告へissue番号を渡して終える（#1583）", () => {
    const result = runStep("00.check-user を外しマージ完了を通知する", {
      HEAD_REF: "issue-1583",
      STUB_LABEL_LIST_FAIL: "1",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1583"]);
  });

  it("ラベル操作・コメント投稿が失敗しても、進捗報告へissue番号を渡す", () => {
    const result = runStep("00.check-user を外しマージ完了を通知する", {
      HEAD_REF: "issue-1583",
      STUB_ISSUE_WRITE_FAIL: "1",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1583"]);
  });

  it("issue-<番号>以外のブランチでは何も報告しない", () => {
    const result = runStep("00.check-user を外しマージ完了を通知する", {
      HEAD_REF: "feature/foo",
    });

    expect(result.reported).toEqual([]);
  });

  it("PR作成の通知でも、ラベル付与の失敗で進捗報告を落とさない", () => {
    const result = runStep("PR作成をIssueへ通知する", {
      HEAD_REF: "issue-1583",
      AUTO_MERGE_PATH: "false",
      STUB_ISSUE_WRITE_FAIL: "1",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1583"]);
  });
});

describe("Project Status の報告", () => {
  const reportStep = "Project Status を報告する";
  const base = { ISSUE_NUMBERS: "1583", STATUS: "develop-pr" };

  it("一時的な5xxを再試行し、成功したら報告済みとして扱う", () => {
    const result = runStep(reportStep, { ...base, STUB_POST_CODES: "500 503 200" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("issue #1583 を develop-pr として報告しました");
    expect(result.calls).toContain("sleep 10");
    expect(result.calls).toContain("sleep 20");
  });

  it("再試行し切っても失敗なら警告に留め、ジョブは落とさない", () => {
    const result = runStep(reportStep, { ...base, STUB_POST_CODES: "500 500 500 500" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::Project Statusの報告に失敗しました");
  });

  it("4xxは設定の誤りなので再試行しない", () => {
    const result = runStep(reportStep, { ...base, STUB_POST_CODES: "401 200 200 200" });

    expect(result.stdout).toContain("HTTP 401");
    expect(result.calls).not.toContain("sleep");
  });

  it("接続自体に失敗した場合（HTTP 000）も再試行する", () => {
    const result = runStep(reportStep, { ...base, STUB_POST_CODES: "000 200" });

    expect(result.stdout).toContain("issue #1583 を develop-pr として報告しました");
  });
});

describe("main-direct-pr-opened / main-direct-merged（main直行リポジトリ・#1901）", () => {
  const OPENED_STEP = "main宛のPR作成をIssueへ通知する";
  const MERGED_STEP = "00.check-user を外しmainへのマージを通知する";
  const CLOSE_STEP = "mainへ到達したissueをcloseする";

  it("main宛PRの作成で、常に00.check-userと01.check-mergeを付ける", () => {
    const result = runStep(OPENED_STEP, { HEAD_REF: "issue-1901" });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1901"]);
    // base=mainのPRは claude-review-develop.yml の対象外で必ず人がマージするため、
    // develop-pr-openedのような経路の有無の調査を挟まず常に付ける
    expect(result.calls).toContain("--add-label 00.check-user --add-label 01.check-merge");
    expect(result.calls).toContain("mainへのPRを作成しました");
  });

  it("ラベル一覧がHTTP 503でも落ちず、進捗の報告へissue番号を渡す", () => {
    const result = runStep(OPENED_STEP, {
      HEAD_REF: "issue-1901",
      STUB_LABEL_LIST_FAIL: "1",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1901"]);
  });

  it("issue-<番号>以外のブランチからのmain宛PRでは何も報告しない", () => {
    const result = runStep(OPENED_STEP, { HEAD_REF: "release/v1.2.0" });

    expect(result.reported).toEqual([]);
  });

  it("main宛PRのマージで、確認系ラベルを外して進捗の報告へissue番号を渡す", () => {
    const result = runStep(MERGED_STEP, { HEAD_REF: "issue-1901" });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1901"]);
    expect(result.calls).toContain("--remove-label 00.check-user");
    expect(result.calls).toContain("mainへのマージが完了しました");
  });

  it("ラベル操作・コメント投稿が失敗しても、進捗の報告へissue番号を渡す", () => {
    const result = runStep(MERGED_STEP, {
      HEAD_REF: "issue-1901",
      STUB_ISSUE_WRITE_FAIL: "1",
    });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1901"]);
  });

  it("closeステップは受け取ったissueをcloseし、失敗してもジョブを落とさない", () => {
    const ok = runStep(CLOSE_STEP, { ISSUE_NUMBERS: "1901" });
    expect(ok.status).toBe(0);
    expect(ok.calls).toContain("gh issue close 1901");

    const failed = runStep(CLOSE_STEP, { ISSUE_NUMBERS: "1901", STUB_ISSUE_WRITE_FAIL: "1" });
    expect(failed.status).toBe(0);
    expect(failed.stdout).toContain("::warning::issue #1901: closeに失敗しました");
  });

  it("`done`の報告をcloseより先に置く（#1856の終端遷移と競合させない）", () => {
    // 先にcloseすると、issue-deckがcloseを受けて`Implementation`・`Develop PR`から
    // 終端`Closed`へ送る経路（closeStrandedProgress）に当たり、`Done`ではなく
    // `Closed`へ落ちうる。順序そのものが仕様なので、入れ替えを検知できるようにする。
    const merged = workflowYaml.slice(workflowYaml.indexOf("  main-direct-merged:"));
    expect(merged.indexOf("STATUS: done")).toBeGreaterThan(-1);
    expect(merged.indexOf("STATUS: done")).toBeLessThan(merged.indexOf(`- name: ${CLOSE_STEP}`));
  });
});
