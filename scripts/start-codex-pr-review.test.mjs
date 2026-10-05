// `scripts/start-codex-pr-review.sh --run`が、PRレビューのジョブ（`PR_REVIEW`・#3990）の状態を
// issue-deckへ報告することを、gh・codex・curlをスタブに差し替えて確かめる。
//
// 確かめたいのは「どの経路で終わっても、終了が1回だけ報告される」こと。起動前に落ちた場合も
// `failed`で報告され、Actionsが30分待たずに原因が分かる。ローカルのbare repoを`origin`にして、
// PR ref（`refs/pull/N/head`）とdevelopを実物のgitで取る。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let dir;
let headSha;
let baseSha;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codex-pr-review-test-"));
  const origin = path.join(dir, "origin.git");
  const clone = path.join(dir, "clone");
  execFileSync("git", ["init", "--bare", "--initial-branch=develop", origin]);
  execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "config", "user.name", "t");
  writeFileSync(path.join(clone, "a.txt"), "base\n");
  git(clone, "add", ".");
  git(clone, "commit", "-m", "base");
  git(clone, "push", "origin", "HEAD:develop");
  baseSha = git(clone, "rev-parse", "HEAD");
  writeFileSync(path.join(clone, "a.txt"), "head\n");
  git(clone, "commit", "-am", "head");
  headSha = git(clone, "rev-parse", "HEAD");
  git(clone, "push", "origin", "HEAD:refs/pull/7/head");

  writeFileSync(path.join(dir, "local-repos.conf"), `guchi-apps/issue-deck ${clone}\n`);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub(
    "gh",
    `printf '%s\\n' "$*" >> "$TEST_GH_CALLS"
if [[ "$1 $2" == "pr comment" ]]; then
  while [[ $# -gt 0 ]]; do [[ "$1" == --body-file ]] && cp "$2" "$TEST_POSTED"; shift; done
  echo "https://github.com/guchi-apps/issue-deck/pull/7#issuecomment-1"
elif [[ "$1" == api ]]; then
  echo issue-3990
fi`,
  );
  // \`--output-last-message <file>\`へ、環境変数の本文を書く。
  stub(
    "codex",
    `out=""
while [[ $# -gt 0 ]]; do [[ "$1" == --output-last-message ]] && out="$2"; shift; done
cat >/dev/null
[[ "$TEST_CODEX_EXIT" == 0 ]] || exit "$TEST_CODEX_EXIT"
printf '%s' "$TEST_CODEX_OUTPUT" > "$out"`,
  );
  // 送られたJSON本文だけを記録する。設定の取得（GET）には何も返さない。
  stub(
    "curl",
    `while [[ $# -gt 0 ]]; do
  [[ "$1" == --data-binary ]] && printf '%s\\n' "$2" >> "$TEST_CURL_BODIES"
  shift
done
exit 0`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args, extraEnv = {}) {
  try {
    const stdout = execFileSync("bash", ["scripts/start-codex-pr-review.sh", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
        CODEX_HOME: path.join(dir, "codex-home"),
        XDG_STATE_HOME: path.join(dir, "state"),
        ISSUE_DECK_LOCAL_REPOS_CONFIG: path.join(dir, "local-repos.conf"),
        ISSUE_DECK_CODEX_PR_REVIEW_ROOT: path.join(dir, "work"),
        ISSUE_DECK_DISPATCH_ENV: path.join(dir, "no-such.env"),
        APP_BASE_URL: "http://issue-deck.test",
        DISPATCH_SECRET: "secret",
        DISPATCH_HOST_NAME: "test-host",
        ISSUE_DECK_PR_REVIEW_HEARTBEAT_SECONDS: "3600",
        TEST_GH_CALLS: path.join(dir, "gh-calls"),
        TEST_POSTED: path.join(dir, "posted.md"),
        TEST_CURL_BODIES: path.join(dir, "curl-bodies"),
        TEST_CODEX_EXIT: "0",
        TEST_CODEX_OUTPUT: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr) };
  }
}

/** pollerへ向けた報告（`/api/dispatch/report`）だけを順に取り出す */
function reports() {
  const file = path.join(dir, "curl-bodies");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((body) => body.jobId !== undefined);
}

const review = (job = "job-1", pr = "7") => ["--run", "guchi-apps", "issue-deck", pr, baseSha, headSha, job];

it("判定が出たら、判定印をPRへ投稿し、ジョブへ判定つきの成功を1回だけ報告する", () => {
  const result = run(review(), {
    TEST_CODEX_OUTPUT: `問題ありません。\n\n<!-- issue-deck-codex-review-verdict:lgtm sha=${headSha} -->`,
  });
  expect(result.status).toBe(0);
  expect(readFileSync(path.join(dir, "posted.md"), "utf8")).toContain(
    `issue-deck-codex-review-verdict:lgtm sha=${headSha}`,
  );
  const sent = reports();
  expect(sent[0]).toMatchObject({ jobId: "job-1", host: "test-host", status: "running" });
  const finished = sent.filter((body) => body.status !== "running");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ status: "succeeded", reviewVerdict: "lgtm" });
});

it("要修正の判定もそのまま報告する", () => {
  run(review(), {
    TEST_CODEX_OUTPUT: `直してください。\n<!-- issue-deck-codex-review-verdict:changes-requested sha=${headSha} -->`,
  });
  expect(reports().at(-1)).toMatchObject({ status: "succeeded", reviewVerdict: "changes-requested" });
});

it("判定を読み取れない出力は、failed印をPRへ残し、失敗として報告する", () => {
  run(review(), { TEST_CODEX_OUTPUT: "判定を書き忘れた出力" });
  expect(readFileSync(path.join(dir, "posted.md"), "utf8")).toContain(
    `issue-deck-codex-review-verdict:failed sha=${headSha}`,
  );
  const last = reports().at(-1);
  expect(last.status).toBe("failed");
  expect(last.message).toContain("有効な判定");
  expect(last.reviewVerdict).toBeUndefined();
});

it("Codexが失敗したら、終了コードつきで失敗を報告する", () => {
  run(review(), { TEST_CODEX_EXIT: "3" });
  const last = reports().at(-1);
  expect(last.status).toBe("failed");
  expect(last.message).toContain("終了コード 3");
});

it("起動前（PR refを取得できない）に落ちても、失敗が1回だけ報告される", () => {
  const result = run(review("job-2", "99"));
  expect(result.status).not.toBe(0);
  const sent = reports();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ jobId: "job-2", status: "failed" });
  expect(sent[0].message).toContain("worktreeの作成に失敗");
});

it("ジョブIDなし（手元での単体実行）では報告せずにレビューだけ行う", () => {
  const result = run(["--run", "guchi-apps", "issue-deck", "7", baseSha, headSha], {
    TEST_CODEX_OUTPUT: `<!-- issue-deck-codex-review-verdict:lgtm sha=${headSha} -->`,
  });
  expect(result.status).toBe(0);
  expect(reports()).toHaveLength(0);
});

it("廃止した--sweepは受け付けない（PRコメントの巡回をジョブキューにしない）", () => {
  const result = run(["--sweep", "guchi-apps", "issue-deck"]);
  expect(result.status).toBe(2);
});
