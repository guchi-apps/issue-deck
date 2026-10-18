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
[[ -n "\${ARGS_LOG:-}" ]] && echo "$*" >>"$ARGS_LOG"
# UNCONF: 全バッチを未確認にする／UNCONF_FILE: そのファイルを含むバッチ（と全ファイルを並べる相互作用の確認）だけを未確認にする。
# 根拠はUNCONF_TEXT（既定は証跡待ち）。NA_FILE: そのファイルを含むバッチは非該当と報告する（#4768）
checks() {
  local s="\${UNCONF:+unconfirmed}"
  [[ -n "\${UNCONF_FILE:-}" && "$2" == *"\${UNCONF_FILE}"* ]] && s=unconfirmed
  [[ -z "$s" && -n "\${NA_FILE:-}" && "$2" == *"\${NA_FILE}"* ]] && s=not_applicable
  jq -nc --arg e "$1" --arg s "$s" --arg u "\${UNCONF_TEXT:-統合検証の結果待ち}" '[${JSON.stringify(CHECK_IDS)}[] | {id: ., status: (if $s == "" then "confirmed" else $s end), evidence: (if $s == "unconfirmed" then $u else $e end)}]'
}
if grep -q "バッチをまたぐ相互作用の確認" <<<"$p"; then
  [[ -n "\${FAIL_INT:-}" ]] && exit 3
  [[ -n "\${INT_LOG:-}" ]] && echo call >>"$INT_LOG"
  c="$(checks 統合で確認 "$p")"
  # INT_OMIT: 相互作用の確認が確認項目を報告しない／INT_CONFIRM: バッチの結果にかかわらず確認済みと報告する
  [[ -n "\${INT_OMIT:-}" ]] && c='[]'
  [[ -n "\${INT_CONFIRM:-}" ]] && c="$(UNCONF= UNCONF_FILE= checks 統合で確認)"
  echo '\`\`\`json'
  jq -nc --argjson c "$c" '{state: "passed", summary: "統合", checklistVersion: 1, checks: $c, fileReviews: []}'
  echo '\`\`\`'
  exit 0
fi
# 実績の補完（#4768）。聞き直されたファイルを根拠つきで確認済みと報告する（SUP_FAILなら失敗）
if grep -q "ファイル別の確認実績の補完です" <<<"$p"; then
  [[ -n "\${SUP_LOG:-}" ]] && echo call >>"$SUP_LOG"
  [[ -n "\${SUP_FAIL:-}" ]] && exit 3
  files="$(sed -n '/取りこぼした断片だけ）:/,/^$/p' <<<"$p" | grep -E '^- ' | sed -E 's/^- //')"
  # SUP_EXTRA: 聞き直されていないファイルも確認済みと報告する／SUP_EMPTY_EV: 根拠を空で報告する
  echo '\`\`\`json'
  jq -nc --argjson f "$(printf '%s\\n' $files \${SUP_EXTRA:-} | jq -Rsc 'split("\\n") | map(select(. != ""))')" --arg ev "\${SUP_EMPTY_EV:+ }" \\
    '{state: "passed", summary: "補完", checklistVersion: 1, checks: [], fileReviews: ($f | map({file: ("/" + .), status: "reviewed", evidence: (if $ev == "" then "補完で読んだ" else "" end)})), findings: []}'
  echo '\`\`\`'
  exit 0
fi
[[ -n "\${CALL_LOG:-}" ]] && echo call >>"$CALL_LOG"
batch="$(sed -nE 's/.*これはバッチ([0-9]+)\\/.*/\\1/p' <<<"$p" | head -n 1)"
# FAIL_BATCH: そのバッチだけ失敗する／TURN_LIMIT_BATCH: そのバッチだけターン数の上限で終わる（claudeと同じく標準出力へ書いて1で終わる）
[[ -n "\${FAIL_BATCH:-}" && "$batch" == "$FAIL_BATCH" ]] && exit 3
# TURN_LIMIT_ONCE: 初回の呼び出しだけ上限に達する（上限を上げたやり直しでは成功する）。QUOTED_TURNS: 本文に文字列を引用して別の理由で1で終わる
if [[ -n "\${QUOTED_TURNS:-}" && "$batch" == "$QUOTED_TURNS" ]]; then printf 'docsには "Error: Reached max turns (150)" と書かれている\\nその後の説明\\n'; exit 1; fi
if [[ -n "\${TURN_LIMIT_BATCH:-}" && "$batch" == "$TURN_LIMIT_BATCH" ]]; then
  if [[ -n "\${TURN_LIMIT_ONCE:-}" && "$*" == *"--max-turns 500"* ]]; then :; else echo "Error: Reached max turns (150)"; exit 1; fi
fi
# CONC_LOG: 起動と終了を記録し、同時に走った本数を数えられるようにする（SLOWの秒数だけ待つ）
[[ -n "\${CONC_LOG:-}" ]] && echo "start $batch" >>"$CONC_LOG"
[[ -n "\${SLOW:-}" ]] && sleep "$SLOW"
[[ -n "\${CONC_LOG:-}" ]] && echo "end $batch" >>"$CONC_LOG"
# FAKE_FINDINGS（JSONの配列の配列）が与えられたら、バッチ番号の順にバッチごとの指摘として返す（並列でも決まる）
findings='[]'
if [[ -n "\${FAKE_FINDINGS:-}" ]]; then
  findings="$(jq -c --argjson n "$batch" '.[($n - 1) % length]' <<<"$FAKE_FINDINGS")"
fi
files="$(sed -n '/次のファイルの差分をこのバッチへ載せました/,/^$/p' <<<"$p" | grep -E '^- ' | sed -E 's/^- //; s/（分割.*//')"
# OMIT_FILE: そのファイルの実績を報告しない／EMPTY_EV_FILE: 根拠を空で報告する／DOT_PATHS: パスを「./」付きで報告する
echo '\`\`\`json'
jq -nc --argjson c "$(checks バッチで確認 "$files")" --argjson f "$(printf '%s\\n' $files | jq -Rsc 'split("\\n") | map(select(. != ""))')" \\
  --arg omit "\${OMIT_FILE:-}" --arg empty "\${EMPTY_EV_FILE:-}" --arg dot "\${DOT_PATHS:-}" --argjson fd "$findings" \\
  '{state: "passed", summary: "batch", checklistVersion: 1, checks: $c, findings: $fd,
    fileReviews: ($f | map(select(. != $omit) | {file: ((if $dot == "" then "" else "./" end) + .), status: "reviewed", evidence: (if . == $empty then "" else "読んだ" end)}))}'
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

  it("バッチ間の同じ指摘は、題の表記揺れ・行の違いに依らず1件にまとめ、止める指摘を残す（#4766）", () => {
    const fakeFindings = [
      [{ severity: "medium", title: "設定漏れ", file: "a.ts", line: 3, blocking: false }],
      [{ severity: "high", title: "設定 漏れ。", file: "a.ts", line: 9 }],
      [{ severity: "high", title: "設定漏れ", file: "b.ts", line: 3 }],
    ];
    const { result } = runReview({ FAKE_FINDINGS: JSON.stringify(fakeFindings) });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.find((f) => f.file === "a.ts")).toMatchObject({ line: 9 });
    expect(result.findings.find((f) => f.file === "a.ts").blocking).not.toBe(false);
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
  describe("実績の取りこぼしの補完と項目の集計（#4768）", () => {
    const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const reviewed = (result) => result.fileReviews.filter((r) => r.status === "reviewed").map((r) => r.file);

    it("「./」付きのパスで報告されても、差分のパスへ揃えて確認済みに数える（補完は呼ばない）", () => {
      const sup = path.join(dir, "sup");
      const { status, result } = runReview({ DOT_PATHS: "1", SUP_LOG: sup });
      expect(status).toBe("succeeded");
      expect(reviewed(result)).toHaveLength(13);
      expect(lines(sup)).toBe(0);
      expect(result.supplementedFiles).toBe(0);
    });

    it("報告の無いファイル・根拠が空のファイルだけを1回だけ聞き直し、補完で確認済みにする。同じ対象の再実行では聞き直さない", () => {
      const sup = path.join(dir, "sup");
      const env = { OMIT_FILE: "file3.txt", EMPTY_EV_FILE: "file4.txt", SUP_LOG: sup };
      const first = runReview(env);
      expect(first.status).toBe("succeeded");
      expect(lines(sup)).toBe(1);
      expect(reviewed(first.result)).toHaveLength(13);
      expect(first.result.fileReviews.find((r) => r.file === "file3.txt").evidence).toContain("補完で確認");
      expect(first.result.supplementedFiles).toBe(2);

      const rerun = runReview(env);
      expect(lines(sup)).toBe(1);
      expect(reviewed(rerun.result)).toHaveLength(13);
    });

    it("補完が失敗しても全体レビューは完走し、取りこぼしたファイルだけを未確認に残す", () => {
      const sup = path.join(dir, "sup");
      const { status, result } = runReview({ OMIT_FILE: "file3.txt", SUP_FAIL: "1", SUP_LOG: sup });
      expect(status).toBe("succeeded");
      expect(lines(sup)).toBe(1);
      expect(reviewed(result)).toHaveLength(12);
      expect(reviewed(result)).not.toContain("file3.txt");
    });

    it("補完が聞き直していないファイル・根拠の空な確認済みを返しても、確認済みに数えない（#4769）", () => {
      // file3.txtとfile4.txtが取りこぼし、補完は件数の上限で先頭の1ファイルだけを聞き直す。応答は聞いていないfile4.txtも確認済みと返す
      const extra = runReview({
        OMIT_FILE: "file3.txt",
        EMPTY_EV_FILE: "file4.txt",
        SUP_EXTRA: "file4.txt",
        ISSUE_DECK_RELEASE_REVIEW_SUPPLEMENT_MAX_FILES: "1",
      });
      expect(reviewed(extra.result)).toContain("file3.txt");
      expect(reviewed(extra.result)).not.toContain("file4.txt");
      expect(extra.result.supplementedFiles).toBe(1);
      rmSync(path.join(dir, "work"), { recursive: true, force: true });
      mkdirSync(path.join(dir, "work"));
      const empty = runReview({ OMIT_FILE: "file3.txt", SUP_EMPTY_EV: "1" });
      expect(reviewed(empty.result)).not.toContain("file3.txt");
      expect(empty.result.supplementedFiles).toBe(0);
    });

    it("差分の上限・件数の上限に入らないファイルは聞き直さず、未確認に残す", () => {
      const sup = path.join(dir, "sup");
      // 巨大ファイルの全断片は1回の補完の上限（差分の予算）を超える
      const huge = runReview({ OMIT_FILE: "huge.txt", SUP_LOG: sup });
      expect(lines(sup)).toBe(0);
      expect(reviewed(huge.result)).not.toContain("huge.txt");
      rmSync(path.join(dir, "work"), { recursive: true, force: true });
      mkdirSync(path.join(dir, "work"));
      const capped = runReview({ OMIT_FILE: "file3.txt", SUP_LOG: sup, ISSUE_DECK_RELEASE_REVIEW_SUPPLEMENT_MAX_FILES: "0" });
      expect(lines(sup)).toBe(0);
      expect(reviewed(capped.result)).not.toContain("file3.txt");
    });

    it("相互作用の確認が根拠つきで報告した項目は、バッチの未確認より優先する", () => {
      const { result } = runReview({ UNCONF_FILE: "file5.txt", INT_CONFIRM: "1" });
      expect(result.checks.every((c) => c.status === "confirmed")).toBe(true);
      expect(result.checks[0].evidence).toContain("[相互作用の確認]");
      // 上書きしたバッチ側の未確認の根拠も併記する（#4769）
      expect(result.checks[0].evidence).toMatch(/／バッチ側の未確認: バッチ\d+: 統合検証の結果待ち/);
    });

    it("相互作用の確認が報告しない項目は、バッチごとの非該当と確認済みの混在を確認済みとして扱う", () => {
      const { result } = runReview({ NA_FILE: "file5.txt", INT_OMIT: "1" });
      expect(result.checks).toHaveLength(6);
      expect(result.checks.every((c) => c.status === "confirmed")).toBe(true);
    });

    it("相互作用の確認が報告せず、未確認と報告したバッチがあれば、そのバッチを示して未確認にする", () => {
      const { result } = runReview({ UNCONF_FILE: "file5.txt", INT_OMIT: "1" });
      expect(result.checks.every((c) => c.status === "unconfirmed")).toBe(true);
      expect(result.checks[0].evidence).toMatch(/^バッチ\d+: 統合検証の結果待ち$/);
    });
  });

  describe("バッチの並列実行とターン数の上限（#4769）", () => {
    const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
    // 起動・終了の記録から、同時に走っていた本数の最大を数える
    const maxConcurrency = (file) => {
      let cur = 0;
      let max = 0;
      for (const l of lines(file)) {
        cur += l.startsWith("start") ? 1 : -1;
        max = Math.max(max, cur);
      }
      return max;
    };
    const savedResults = () => readdirSync(path.join(dir, "work", batchDirs()[0])).filter((n) => /^r\d+\.json$/.test(n));

    it("上限の本数まで同時に確認し、結果は1本ずつのときと同じに組み立てる", () => {
      const conc = path.join(dir, "conc");
      const { status, result } = runReview({ SLOW: "1", CONC_LOG: conc, ISSUE_DECK_RELEASE_REVIEW_PARALLEL: "3" });
      expect(status).toBe("succeeded");
      expect(maxConcurrency(conc)).toBe(3);
      expect(result.fileReviews.filter((r) => r.status === "reviewed")).toHaveLength(13);
      expect(result.rerunBatches).toBe(result.batches);
      expect(result.checks.every((c) => c.status === "confirmed")).toBe(true);

      rmSync(path.join(dir, "work"), { recursive: true, force: true });
      mkdirSync(path.join(dir, "work"));
      rmSync(conc);
      runReview({ CONC_LOG: conc, ISSUE_DECK_RELEASE_REVIEW_PARALLEL: "1" });
      expect(maxConcurrency(conc)).toBe(1);
    });

    it("1本が失敗したら新しいバッチは起動せず、実行中の結果は保存して失敗を報告し、再実行は失敗したバッチから続ける", () => {
      const calls = path.join(dir, "calls");
      const failed = runReview({ FAIL_BATCH: "2", CALL_LOG: calls, ISSUE_DECK_RELEASE_REVIEW_PARALLEL: "3" });
      expect(failed.status).toBe("failed");
      expect(failed.result.diagnostic).toMatchObject({ cause: "unknown", exitCode: 3, stage: "review" });
      // 同時に起動したバッチ1・3は保存し、4以降は起動しない
      expect(savedResults().sort()).toEqual(["r1.json", "r3.json"]);
      const before = lines(calls).length;

      const rerun = runReview({ CALL_LOG: calls });
      expect(rerun.status).toBe("succeeded");
      expect(rerun.result.reusedBatches).toBe(2);
      expect(rerun.result.rerunBatches).toBe(rerun.result.batches - 2);
      expect(lines(calls).length - before).toBe(rerun.result.batches - 2);
    });

    it("未実施のバッチの理由は、実際のバッチ番号で示す（途中のバッチが欠けても番号がずれない）", () => {
      runReview({ FAIL_BATCH: "2", ISSUE_DECK_RELEASE_REVIEW_PARALLEL: "3" });
      const { result } = runReview({ ISSUE_DECK_RELEASE_REVIEW_MAX_BATCHES_PER_RUN: "0" });
      expect(result.pendingBatches).toBe(result.batches - 2);
      const evidence = result.checks[0].evidence;
      expect(evidence).toContain("バッチ2: 報告がありません");
      expect(evidence).not.toContain("バッチ1:");
      expect(evidence).not.toContain("バッチ3:");
      expect(evidence).toContain(`バッチ${result.batches}: 報告がありません`);
    });

    it("claudeへターン数の上限を渡し、上限に達した失敗を診断で区別する", () => {
      const args = path.join(dir, "args");
      const { status, result } = runReview({ TURN_LIMIT_BATCH: "1", ARGS_LOG: args });
      expect(status).toBe("failed");
      expect(result.diagnostic).toMatchObject({ cause: "turn_limit", exitCode: 1 });
      expect(result.diagnostic.excerpt).toContain("Reached max turns");
      expect(lines(args).every((l) => l.includes("--max-turns 300") || l.includes("--max-turns 500"))).toBe(true);

      rmSync(args);
      runReview({ ARGS_LOG: args, ISSUE_DECK_RELEASE_REVIEW_MAX_TURNS: "0" });
      expect(lines(args).some((l) => l.includes("--max-turns"))).toBe(false);
    });

    it("ターン数の上限で失敗したバッチだけ、上限（ターン数・時間）を上げて1回やり直す（#4785）", () => {
      const args = path.join(dir, "args");
      const { status, result } = runReview({ TURN_LIMIT_BATCH: "1", TURN_LIMIT_ONCE: "1", ARGS_LOG: args });
      expect(status).toBe("succeeded");
      const l = lines(args);
      expect(l.filter((x) => x.includes("--max-turns 500"))).toHaveLength(1);
      expect(l.filter((x) => x.includes("--max-turns 300")).length).toBeGreaterThan(1);
      expect(result.pendingBatches).toBe(0);
    });

    it("やり直しても上限に達したら失敗として報告し、診断に再試行済みと適用した上限を残す（#4785）", () => {
      const args = path.join(dir, "args");
      const { status, result } = runReview({ TURN_LIMIT_BATCH: "1", ARGS_LOG: args });
      expect(status).toBe("failed");
      expect(result.diagnostic).toMatchObject({ cause: "turn_limit", turnLimitRetried: true, maxTurns: 500 });
      expect(lines(args).filter((x) => x.includes("--max-turns 500"))).toHaveLength(1);
    });

    it("本文に引用された「Reached max turns」では turn_limit にせず、やり直しもしない（#4785）", () => {
      const args = path.join(dir, "args");
      const { status, result } = runReview({ QUOTED_TURNS: "1", ARGS_LOG: args });
      expect(status).toBe("failed");
      expect(result.diagnostic.cause).toBe("unknown");
      expect(lines(args).some((x) => x.includes("--max-turns 500"))).toBe(false);
    });

    it("進捗の分母は全バッチ数に揃え、失敗後は実行中の完了を待っている旨を出す（#4785）", () => {
      const out = execFileSync(
        "bash",
        [
          "-c",
          `source "${repoRoot}/scripts/run-release-review.sh"; batch_count=5
batch_progress_message 全体確認 claude opus 1 1 0 13 3 4; echo
batch_progress_message 全体確認 claude opus 1 0 1 13 4 5; echo`,
        ],
        { encoding: "utf8" },
      );
      const [running, waiting] = out.trim().split("\n");
      expect(running).toContain("バッチ3・4/5を並列で確認中");
      expect(running).toContain("完了2/5（再利用1）");
      expect(waiting).toContain("失敗したバッチがあり、実行中の2本の完了を待っています");
      expect(waiting).toContain("完了1/5");
    });

    it("進捗の文面は、実行中のバッチが複数なら並べて示す", () => {
      const out = execFileSync(
        "bash",
        ["-c", `source "${repoRoot}/scripts/run-release-review.sh"; batch_count=5; batch_running_label 2; echo; batch_running_label 2 3 4`],
        { encoding: "utf8" },
      );
      expect(out.split("\n")).toEqual(["バッチ2/5", "バッチ2・3・4/5を並列で確認中"]);
    });
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
