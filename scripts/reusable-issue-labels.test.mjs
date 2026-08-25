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
    state=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--head" ]; then head="$2"; fi
      if [ "$1" = "--state" ]; then state="$2"; fi
      shift
    done
    if [ "$state" = "open" ]; then
      var="STUB_PR_OPEN_\${head#issue-}"
    else
      var="STUB_PR_\${head#issue-}"
    fi
    value="\${!var:-}"
    if [ -z "$value" ]; then echo "[]"
    elif [ "$value" = "fail" ]; then echo "gh: server error (HTTP 502)" >&2; exit 1
    else echo "$value"; fi
    ;;
  "api --method")
    # manual-step-body-checkが指摘コメントを消す・貼り直す（DELETE / PATCH）。
    # 呼び出しの全文は $STUB_LOG に残るので、ここは成功して返すだけでよい
    ;;
  "api repos"*)
    # manual-step-body-checkが引く「前回の指摘コメントのid」
    # （repos/<owner>/<repo>/issues/<n>/comments?per_page=100 を --jq でid化したもの）
    if [[ "$2" == */comments\?* ]]; then
      if [ "\${STUB_EXISTING_COMMENT:-}" = "fail" ]; then echo "gh: server error" >&2; exit 1; fi
      [ -z "\${STUB_EXISTING_COMMENT:-}" ] || echo "\${STUB_EXISTING_COMMENT}"
      exit 0
    fi
    # develop-merge-sweepが引く「developとブランチの差分」（repos/<owner>/<repo>/compare/develop...issue-<n>）
    if [[ "$2" == */compare/* ]]; then
      var="STUB_COMPARE_\${2##*...issue-}"
      value="\${!var:-}"
      if [ "$value" = "fail" ]; then echo "gh: server error" >&2; exit 1; fi
      if [ -z "$value" ]; then value='{"ahead_by":0,"commits":[]}'; fi
      echo "$value"
      exit 0
    fi
    # wip-on-pushが引く「このコミットに紐づくPR」（repos/<owner>/<repo>/commits/<sha>/pulls）
    if [[ "$2" == */pulls ]]; then
      if [ "\${STUB_COMMIT_PULLS:-}" = "fail" ]; then exit 1; fi
      echo "\${STUB_COMMIT_PULLS:-[]}"
      exit 0
    fi
    var="STUB_REF_\${2##*/issue-}"
    value="\${!var:-404}"
    if [ "$value" = "404" ]; then echo '{"message":"Not Found","status":"404"}'; exit 1
    elif [ "$value" = "fail" ]; then echo "gh: server error" >&2; exit 1
    else echo "{\\"object\\":{\\"sha\\":\\"$value\\"}}"; fi
    ;;
  "issue view")
    if [ "\${STUB_ISSUE_VIEW_FAIL:-0}" = "1" ]; then
      echo "gh: server error (HTTP 500)" >&2
      exit 1
    fi
    var="STUB_COMMENTS_$3"
    value="\${!var:-}"
    if [ -z "$value" ]; then echo '{"comments":[]}'; else echo "$value"; fi
    ;;
  "issue edit"|"issue comment"|"issue close")
    if [ "\${STUB_ISSUE_WRITE_FAIL:-0}" = "1" ]; then
      echo "gh: server error (HTTP 500)" >&2
      exit 1
    fi
    # 本文が空のコメント投稿はGitHubが拒否する（#2106で実際にジョブが落ちた）。
    # スタブが黙って成功すると、その失敗経路をテストで踏めない
    if [ "$2" = "comment" ]; then
      file=""
      for arg in "$@"; do
        if [ "\${prev:-}" = "--body-file" ]; then file="$arg"; fi
        prev="$arg"
      done
      if [ -n "$file" ] && [ -z "$(tr -d '[:space:]' < "$file")" ]; then
        echo "GraphQL: Body cannot be blank (addComment)" >&2
        exit 1
      fi
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
  [ -z "$out" ] || printf '%s' "\${STUB_POST_BODY:-}" > "$out"
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
      // ステップが作る一時ファイル（request.json・comment.md など）をリポジトリへ落とさない
      cwd: workDir,
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

// `develop-merge-sweep`のテストはここにあったが、ジョブごとissue-deck側の巡回へ移した（#2294）。
// 判定は`src/lib/github/progress-sweep.test.ts`、巡回は`src/lib/github/progress-sweep-run.test.ts`。

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

describe("manual-step-body-check（手作業Issueの本文検査・#2048）", () => {
  const STEP = "本文の書式を検査して指摘コメントを貼り直す";
  const base = {
    ISSUE_NUMBER: "2105",
    ISSUE_TITLE: "[手作業] サブPC: pollerを再起動する",
    ISSUE_BODY: "## この作業でできるようになること\n",
  };
  /** 指摘が1件も無いときのAPI応答。`comment`はnullで返る */
  const noFindings = { STUB_POST_BODY: '{"findings":[],"comment":null}' };
  const withFinding = {
    STUB_POST_BODY: JSON.stringify({
      findings: [{ severity: "error", message: "## 関連 の対応PRがURLで書かれています" }],
      comment: "<!-- issue-deck-source:manual-step-body-check -->\n⚠️ ...",
    }),
  };

  it("指摘が無いときはコメントを投稿しない（#2106の空本文でのジョブ失敗）", () => {
    // `jq -r`が付ける末尾の改行で comment.md が1バイトになり、`[ -s ]`を素通りして
    // 空本文の投稿へ進んでいた。書式どおりの手作業Issueを起票するたびに落ちていた
    const result = runStep(STEP, { ...base, ...noFindings });

    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("gh issue comment");
    expect(result.stdout).toContain("本文の書式に指摘はありません");
  });

  it("指摘が解消したら前回の指摘コメントを削除する", () => {
    // 削除も同じifの中にあるため、#2106の間は「直しても古い指摘が残る」状態だった
    const result = runStep(STEP, {
      ...base,
      ...noFindings,
      STUB_EXISTING_COMMENT: "9001",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      "gh api --method DELETE repos/guchi-apps/issue-deck/issues/comments/9001",
    );
    expect(result.stdout).toContain("前回のコメントを削除しました");
  });

  it("指摘があれば指摘コメントを投稿する", () => {
    const result = runStep(STEP, { ...base, ...withFinding });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("gh issue comment 2105 --body-file comment.md");
    expect(result.stdout).toContain("指摘コメントを投稿しました");
  });

  it("前回の指摘コメントがあれば、重ねず更新する", () => {
    const result = runStep(STEP, {
      ...base,
      ...withFinding,
      STUB_EXISTING_COMMENT: "9001",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      "gh api --method PATCH repos/guchi-apps/issue-deck/issues/comments/9001",
    );
    expect(result.calls).not.toContain("gh issue comment");
    expect(result.stdout).toContain("指摘コメントを更新しました");
  });

  it("タイトルが[手作業]で始まらないIssueには何もしない", () => {
    const result = runStep(STEP, {
      ...base,
      ...withFinding,
      ISSUE_TITLE: "pollerを再起動する",
    });

    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("gh issue comment");
  });

  it("APP_BASE_URLが未設定のリポジトリでは検査ごとスキップする", () => {
    const result = runStep(STEP, { ...base, ...withFinding, APP_BASE_URL: "" });

    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("curl");
    expect(result.stdout).toContain("書式検査をスキップします");
  });

  it("issue-deckが落ちていてもワークフローを失敗させない", () => {
    const result = runStep(STEP, {
      ...base,
      ...withFinding,
      STUB_POST_CODES: "500",
    });

    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("gh issue comment");
    expect(result.stdout).toContain("::warning::本文の書式検査に失敗しました");
  });
});

describe("wip-on-push のマージ済み判定", () => {
  const STEP = "対象issueを特定する";
  const base = { GITHUB_REF_NAME: "issue-1901", HEAD_SHA: "aaa111" };
  const pulls = (baseRef, headRef) =>
    JSON.stringify([{ merged_at: "2026-08-18T00:00:00Z", base: { ref: baseRef }, head: { ref: headRef } }]);

  it("main直行リポジトリのマージ済みPRでも巻き戻さない（#1901）", () => {
    // develop決め打ちのままだと「マージ済みでない」と判定し、遅れて走ったrunが
    // main-direct-mergedの`Done`を`Implementation`へ戻してしまう
    const result = runStep(STEP, { ...base, STUB_COMMIT_PULLS: pulls("main", "issue-1901") });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual([]);
  });

  it("developへマージ済みのpushも従来どおり巻き戻さない（#1511）", () => {
    const result = runStep(STEP, { ...base, STUB_COMMIT_PULLS: pulls("develop", "issue-1901") });

    expect(result.reported).toEqual([]);
  });

  it("ブランチ名が一致しないPR（developの先端から切った直後のpush）は巻き込まない", () => {
    const result = runStep(STEP, { ...base, STUB_COMMIT_PULLS: pulls("main", "develop") });

    expect(result.reported).toEqual(["1901"]);
  });

  it("マージ済みPRが無ければ implementation を報告する", () => {
    const result = runStep(STEP, base);

    expect(result.reported).toEqual(["1901"]);
  });

  it("PRを取得できないときは報告する側へ倒す（fail-open）", () => {
    const result = runStep(STEP, { ...base, STUB_COMMIT_PULLS: "fail" });

    expect(result.status).toBe(0);
    expect(result.reported).toEqual(["1901"]);
    expect(result.stdout).toContain("紐づくPRを取得できませんでした");
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
