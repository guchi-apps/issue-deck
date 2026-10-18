// `scripts/run-release-review.sh`のバッチ分割・再開・実績の報告を、一時のgitリポジトリと偽の`claude`で確かめる（#4615）。
//
// 確かめるのは「入力へ載せた数を確認実績にしない」「容量を超えた差分を黙って除外しない」「中断から続きで再開する」
// の3点。AIの判断そのものは偽物なので、レビューの質ではなく、ランナーが実績を正しく組み立てるかだけを固定する。

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_IDS = ["pr_interaction", "auth_boundary", "host_compat", "config_migration", "state_consistency", "ui_truthfulness"];

let dir;
let base;
let head;

const git = (...args) => execFileSync("git", args, { cwd: path.join(dir, "repo"), encoding: "utf8" }).trim();

const FAKE_CLAUDE = `#!/usr/bin/env bash
p="$(cat)"
# UNCONF: 全バッチを未確認にする／UNCONF_FILE: そのファイルを含むバッチだけを未確認にする。根拠はUNCONF_TEXT（既定は証跡待ち）
checks() {
  local s="\${UNCONF:+unconfirmed}"
  [[ -n "\${UNCONF_FILE:-}" && "$2" == *"\${UNCONF_FILE}"* ]] && s=unconfirmed
  jq -nc --arg e "$1" --arg s "$s" --arg u "\${UNCONF_TEXT:-統合検証の結果待ち}" '[${JSON.stringify(CHECK_IDS)}[] | {id: ., status: (if $s == "" then "confirmed" else "unconfirmed" end), evidence: (if $s == "" then $e else $u end)}]'
}
if grep -q "バッチをまたぐ相互作用の確認" <<<"$p"; then
  [[ -n "\${FAIL_INT:-}" ]] && exit 3
  [[ -n "\${INT_LOG:-}" ]] && echo call >>"$INT_LOG"
  echo '\`\`\`json'
  jq -nc --argjson c "$(checks 統合で確認)" '{state: "passed", summary: "統合", checklistVersion: 1, checks: $c, fileReviews: []}'
  echo '\`\`\`'
  exit 0
fi
[[ -n "\${CALL_LOG:-}" ]] && echo call >>"$CALL_LOG"
files="$(sed -n '/次のファイルの差分をこのバッチへ載せました/,/^$/p' <<<"$p" | grep -E '^- ' | sed -E 's/^- //; s/（分割.*//')"
echo '\`\`\`json'
jq -nc --argjson c "$(checks バッチで確認 "$files")" --argjson f "$(printf '%s\\n' $files | jq -Rsc 'split("\\n") | map(select(. != ""))')" \\
  '{state: "passed", summary: "batch", checklistVersion: 1, checks: $c, fileReviews: ($f | map({file: ., status: "reviewed", evidence: "読んだ"}))}'
echo '\`\`\`'
`;

function runReview(env = {}) {
  const script = `
set -euo pipefail
source "${repoRoot}/scripts/run-release-review.sh"
local_repo_resolve_path() { echo "${dir}/repo"; }
review_report() { [[ "$1" == running ]] || { echo "$1" > "${dir}/status"; echo "\${3:-}" > "${dir}/result.json"; }; }
main o r 7 ${base} ${head} 1 claude opus x
`;
  spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${dir}/bin:${process.env.PATH}`,
      ISSUE_DECK_RELEASE_REVIEW_ROOT: path.join(dir, "work"),
      ISSUE_DECK_RELEASE_REVIEW_DIFF_BUDGET_BYTES: "20000",
      ...env,
    },
    encoding: "utf8",
  });
  const status = readFileSync(path.join(dir, "status"), "utf8").trim();
  const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8") || "{}");
  return { status, result };
}

const batchDirs = () => readdirSync(path.join(dir, "work")).filter((n) => n.endsWith(".batches"));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "release-review-test-"));
  mkdirSync(path.join(dir, "repo"));
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(path.join(dir, "work"));
  writeFileSync(path.join(dir, "bin", "claude"), FAKE_CLAUDE);
  chmodSync(path.join(dir, "bin", "claude"), 0o755);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "repo", "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  for (let i = 1; i <= 12; i += 1) {
    writeFileSync(path.join(dir, "repo", `file${i}.txt`), Array.from({ length: 200 }, (_, n) => `f${i} line ${n}`).join("\n") + "\n");
  }
  // 1バッチの上限（20000文字）を超える巨大ファイル
  writeFileSync(path.join(dir, "repo", "huge.txt"), Array.from({ length: 4000 }, (_, n) => `huge line number ${n}`).join("\n") + "\n");
  git("add", ".");
  git("commit", "-qm", "head");
  head = git("rev-parse", "HEAD");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// git・bash・Python・jqを複数回起動する結合テスト。並行検証中のホストでも
// プロセス起動の待ち時間を許容する。アサーションと本番の制限は変更しない（#4693）。
describe("run-release-review.sh（#4615）", { timeout: 30_000 }, () => {
  it("入力上限を超える差分は複数バッチと相互作用の確認へ分け、巨大ファイルも含めて全ファイルの実績を報告する", () => {
    const { status, result } = runReview();
    expect(status).toBe("succeeded");
    expect(result.totalFiles).toBe(13);
    expect(result.batches).toBeGreaterThan(2);
    expect(result.pendingBatches).toBe(0);
    expect(result.targetFiles).toHaveLength(13);
    expect(result.fileReviews.filter((r) => r.status === "reviewed")).toHaveLength(13);
    expect(result.fileReviews.find((r) => r.file === "huge.txt")).toBeTruthy();
    // 入力に載せた数は別に報告し、確認済みの件数は申告しない（サーバーが実績から数える）
    expect(result.inputFiles).toBe(13);
    expect(result).not.toHaveProperty("reviewedFiles");
    expect(result.checks.every((c) => c.status === "confirmed")).toBe(true);
    expect(result.checks[0].evidence).toContain("統合で確認");
    // 完走後も保存を残す（#4767）
    expect(batchDirs()).toHaveLength(1);
    expect(result.reusedBatches).toBe(0);
    expect(result.rerunBatches).toBe(result.batches);
    expect(result.integrationReused).toBe(false);
  });

  it("実行予算で残ったバッチは保存し、再実行が続きから確認する。残りがある間は項目を確認済みにしない", () => {
    const first = runReview({ ISSUE_DECK_RELEASE_REVIEW_MAX_BATCHES_PER_RUN: "2" });
    expect(first.status).toBe("succeeded");
    expect(first.result.pendingBatches).toBeGreaterThan(0);
    expect(first.result.fileReviews.length).toBeLessThan(13);
    expect(first.result.checks.every((c) => c.status === "unconfirmed")).toBe(true);
    expect(batchDirs()).toHaveLength(1);

    const second = runReview();
    expect(second.result.pendingBatches).toBe(0);
    expect(second.result.fileReviews.filter((r) => r.status === "reviewed")).toHaveLength(13);
    expect(second.result.reusedBatches).toBe(2);
    expect(batchDirs()).toHaveLength(1);
  });

  it("相互作用の確認が失敗したら失敗として報告し、バッチごとの結果は残して再実行で続きから確認する", () => {
    const failed = runReview({ FAIL_INT: "1" });
    expect(failed.status).toBe("failed");
    expect(batchDirs()).toHaveLength(1);
    const rerun = runReview();
    expect(rerun.status).toBe("succeeded");
    expect(rerun.result.pendingBatches).toBe(0);
  });

  it("候補のSHAが変わったら、旧SHAの保存済みの結果は使わない", () => {
    runReview({ ISSUE_DECK_RELEASE_REVIEW_MAX_BATCHES_PER_RUN: "2" });
    const oldDir = batchDirs()[0];
    writeFileSync(path.join(dir, "repo", "file1.txt"), "changed\n");
    git("commit", "-qam", "next");
    head = git("rev-parse", "HEAD");
    const next = runReview({ ISSUE_DECK_RELEASE_REVIEW_MAX_BATCHES_PER_RUN: "2" });
    expect(next.status).toBe("succeeded");
    expect(batchDirs()).toHaveLength(2);
    expect(existsSync(path.join(dir, "work", oldDir, "r1.json"))).toBe(true);
    expect(batchDirs().some((n) => n !== oldDir && n.includes(head.slice(0, 12)))).toBe(true);
  });

  it("証跡が更新されたら、証跡に依存する保存済みの結果だけ再評価し、同じ状態の証跡では再利用する（#4632）", () => {
    const evidenceRoot = path.join(dir, "evidence");
    mkdirSync(evidenceRoot);
    const writeEvidence = (state, finishedAt) =>
      writeFileSync(
        path.join(evidenceRoot, `o_r-7-${base.slice(0, 12)}-${head.slice(0, 12)}.json`),
        JSON.stringify({ repository: "o/r", prNumber: 7, baseSha: base, headSha: head, steps: [], outcome: { state }, ...(finishedAt ? { finishedAt } : {}) }),
      );
    const calls = path.join(dir, "calls");
    const env = { ISSUE_DECK_RELEASE_EVIDENCE_ROOT: evidenceRoot, CALL_LOG: calls };
    const countCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0);

    // 統合検証の実行中に確認し、証跡に依存する「未確認」の結果が保存される（相互作用の確認の失敗で保存を残す）
    writeEvidence("running");
    const first = runReview({ ...env, UNCONF: "1", FAIL_INT: "1" });
    expect(first.status).toBe("failed");
    const batches = countCalls();
    expect(batches).toBeGreaterThan(2);

    // 証跡が同じ状態のままなら、保存済みの結果を使い回し、AIを呼ばない
    runReview({ ...env, FAIL_INT: "1" });
    expect(countCalls()).toBe(batches);

    // 証跡がpassedへ更新されたら、未確認のバッチを新しい証跡で再評価する
    writeEvidence("passed", "2026-10-13T10:51:00Z");
    const rerun = runReview(env);
    expect(rerun.status).toBe("succeeded");
    expect(countCalls()).toBeGreaterThanOrEqual(batches * 2);
    expect(rerun.result.checks.every((c) => c.status === "confirmed")).toBe(true);
  });

  it("証跡を取得できないときは、証跡に依存する保存済みの結果を再利用せず再評価する（#4632）", () => {
    const calls = path.join(dir, "calls");
    const env = { ISSUE_DECK_RELEASE_EVIDENCE_ROOT: path.join(dir, "no-evidence"), CALL_LOG: calls };
    runReview({ ...env, UNCONF: "1", FAIL_INT: "1" });
    const before = readFileSync(calls, "utf8").trim().split("\n").length;
    runReview({ ...env, FAIL_INT: "1" });
    expect(readFileSync(calls, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(before * 2);
  });

  it("確認済みだけの保存済みの結果は、証跡が更新されても再利用する（#4632）", () => {
    const evidenceRoot = path.join(dir, "evidence");
    mkdirSync(evidenceRoot);
    const calls = path.join(dir, "calls");
    const env = { ISSUE_DECK_RELEASE_EVIDENCE_ROOT: evidenceRoot, CALL_LOG: calls };
    runReview({ ...env, FAIL_INT: "1" });
    const before = readFileSync(calls, "utf8").trim().split("\n").length;
    writeFileSync(
      path.join(evidenceRoot, `o_r-7-${base.slice(0, 12)}-${head.slice(0, 12)}.json`),
      JSON.stringify({ baseSha: base, headSha: head, steps: [], outcome: { state: "passed" }, finishedAt: "x" }),
    );
    runReview(env);
    expect(readFileSync(calls, "utf8").trim().split("\n").length).toBe(before);
  });
  describe("完走後の再利用（#4767）", () => {
    const evidenceFile = () => path.join(dir, "evidence", `o_r-7-${base.slice(0, 12)}-${head.slice(0, 12)}.json`);
    const writeEvidence = (state, finishedAt) =>
      writeFileSync(
        evidenceFile(),
        JSON.stringify({ repository: "o/r", prNumber: 7, baseSha: base, headSha: head, steps: [], outcome: { state }, ...(finishedAt ? { finishedAt } : {}) }),
      );
    const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const setup = () => {
      mkdirSync(path.join(dir, "evidence"));
      const calls = path.join(dir, "calls");
      const ints = path.join(dir, "ints");
      return { calls, ints, env: { ISSUE_DECK_RELEASE_EVIDENCE_ROOT: path.join(dir, "evidence"), CALL_LOG: calls, INT_LOG: ints } };
    };

    it("同じSHA・同じ証跡で再実行したら、バッチも相互作用の確認もAIを呼ばずに再利用する", () => {
      const { calls, ints, env } = setup();
      writeEvidence("passed", "2026-10-18T10:00:00Z");
      const first = runReview(env);
      expect(first.status).toBe("succeeded");
      const batches = lines(calls);
      expect(batches).toBe(first.result.batches);
      expect(lines(ints)).toBe(1);

      const rerun = runReview(env);
      expect(rerun.status).toBe("succeeded");
      expect(lines(calls)).toBe(batches);
      expect(lines(ints)).toBe(1);
      expect(rerun.result).toMatchObject({ reusedBatches: batches, rerunBatches: 0, integrationReused: true });
      expect(rerun.result.checks.every((c) => c.status === "confirmed")).toBe(true);
    });

    it("証跡が更新されたら、証跡に依存して未確認になったバッチと相互作用の確認だけをやり直す", () => {
      const { calls, ints, env } = setup();
      writeEvidence("running");
      const first = runReview({ ...env, UNCONF_FILE: "file5.txt" });
      expect(first.status).toBe("succeeded");
      const batches = lines(calls);
      expect(batches).toBeGreaterThan(2);
      expect(first.result.checks.every((c) => c.status === "unconfirmed")).toBe(true);

      writeEvidence("passed", "2026-10-18T10:00:00Z");
      const rerun = runReview(env);
      expect(rerun.status).toBe("succeeded");
      // file5.txtを含む1バッチだけをやり直し、残りは再利用する。相互作用の確認はやり直す
      expect(lines(calls)).toBe(batches + 1);
      expect(lines(ints)).toBe(2);
      expect(rerun.result).toMatchObject({ reusedBatches: batches - 1, rerunBatches: 1, integrationReused: false });
      expect(rerun.result.checks.every((c) => c.status === "confirmed")).toBe(true);
    });

    it("証跡を指さない未確認（運用作業など）は、証跡が更新されても再利用する", () => {
      const { calls, env } = setup();
      writeEvidence("running");
      runReview({ ...env, UNCONF_FILE: "file5.txt", UNCONF_TEXT: "サブPCのpollerを更新・再起動する必要があります" });
      const batches = lines(calls);
      writeEvidence("passed", "2026-10-18T10:00:00Z");
      const rerun = runReview(env);
      expect(lines(calls)).toBe(batches);
      expect(rerun.result.reusedBatches).toBe(batches);
    });

    it("保存は件数の上限を超えた古いものから消す", () => {
      runReview();
      writeFileSync(path.join(dir, "repo", "file1.txt"), "changed\n");
      git("commit", "-qam", "next");
      head = git("rev-parse", "HEAD");
      runReview({ ISSUE_DECK_RELEASE_REVIEW_KEEP_BATCH_DIRS: "1" });
      expect(batchDirs()).toHaveLength(1);
      expect(batchDirs()[0]).toContain(head.slice(0, 12));
    });
  });
});
