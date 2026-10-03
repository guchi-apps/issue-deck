import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codex-pr-review-test-"));
  writeFileSync(path.join(dir, "local-repos.conf"), `guchi-apps/issue-deck ${root}\n`);
  const gh = path.join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_GH_CALLS"
if [[ "$1" == api ]]; then
  [[ "$TEST_API_FAILURE" == 0 ]] || exit 1
  printf '39\\tbase-sha\\thead-sha\\n'
elif [[ "$1" == pr && "$2" == view ]]; then
  printf '<!-- issue-deck-codex-review-request sha=head-sha -->\\n'
fi
`,
  );
  chmodSync(gh, 0o755);
  const tmux = path.join(dir, "tmux");
  writeFileSync(
    tmux,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_TMUX_CALLS"
[[ "$1" == has-session ]] && exit 1
exit 0
`,
  );
  chmodSync(tmux, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sweep(extraEnv = {}) {
  try {
    const stdout = execFileSync("bash", ["scripts/start-codex-pr-review.sh", "--sweep", "guchi-apps", "issue-deck"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ISSUE_DECK_LOCAL_REPOS_CONFIG: path.join(dir, "local-repos.conf"),
        ISSUE_DECK_CODEX_PR_REVIEW_ROOT: dir,
        TEST_GH_CALLS: path.join(dir, "gh-calls"),
        TEST_TMUX_CALLS: path.join(dir, "tmux-calls"),
        TEST_API_FAILURE: "0",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr) };
  }
}

it("REST APIでbaseとheadのSHAを取得し、要求のあるPRを起動する", () => {
  const result = sweep();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("issue-deck#39");
  expect(readFileSync(path.join(dir, "gh-calls"), "utf8")).toContain(
    "api repos/guchi-apps/issue-deck/pulls?state=open&base=develop&per_page=100 --paginate",
  );
  expect(readFileSync(path.join(dir, "tmux-calls"), "utf8")).toContain("--run guchi-apps issue-deck 39 base-sha head-sha");
});

it("PR一覧の取得失敗を空一覧として隠さない", () => {
  const result = sweep({ TEST_API_FAILURE: "1" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("レビュー対象PRを取得できませんでした");
});
