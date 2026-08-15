import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 計画前提SHAの陳腐化検知（`scripts/lib/plan-base.sh`・#1215）のテスト。
 *
 * ここで一番効くのは「**止めないこと**」。マーカーが無いIssue・存在しないSHA・壊れたJSONの
 * どれでも、非0で返した瞬間に呼び出し元（`scripts/start-issue.sh` は `set -euo pipefail`）が
 * 落ち、**セッションの起動そのものが止まる**。無関係なマージのたびに起動が詰まるのを避ける、
 * というこの機能の前提が壊れるので、異常系を厚めに固定する。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/plan-base.sh");

function callShell(fn: string, input: string, ...args: string[]): string {
  return execFileSync("bash", ["-c", `set -euo pipefail; source "$0"; ${fn} "$@"`, SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    input,
  });
}

function comments(...bodies: string[]): string {
  return JSON.stringify({ comments: bodies.map((body) => ({ body })) });
}

describe("plan_base_sha_from_comments", () => {
  it("計画コメントの plan-base マーカーからSHAを取る", () => {
    const json = comments("<!-- plan-base: 51591fc80998f2c566504d52ae8ec8fbefa54e91 -->\n\n計画です");
    expect(callShell("plan_base_sha_from_comments", json)).toBe(
      "51591fc80998f2c566504d52ae8ec8fbefa54e91\n",
    );
  });

  it("複数あるときは最後（＝直近の計画）を採る", () => {
    // 計画は修正依頼を受けて出し直されることがあり、前提も出し直すたびに新しくなる
    const json = comments("<!-- plan-base: aaaaaaa -->", "本文", "<!-- plan-base: bbbbbbb -->");
    expect(callShell("plan_base_sha_from_comments", json)).toBe("bbbbbbb\n");
  });

  it("16進7〜40桁でない値は通さない（そのまま git へ渡るため）", () => {
    expect(callShell("plan_base_sha_from_comments", comments("<!-- plan-base: HEAD -->"))).toBe("");
    expect(callShell("plan_base_sha_from_comments", comments("<!-- plan-base: abc123 -->"))).toBe("");
    expect(
      callShell("plan_base_sha_from_comments", comments("<!-- plan-base: $(rm -rf /) -->")),
    ).toBe("");
  });

  it("マーカーが無いIssue・コメントが無いIssueでは何も返さない", () => {
    expect(callShell("plan_base_sha_from_comments", comments("ただのコメント"))).toBe("");
    expect(callShell("plan_base_sha_from_comments", JSON.stringify({ comments: [] }))).toBe("");
    expect(callShell("plan_base_sha_from_comments", "{}")).toBe("");
  });

  it("JSONが壊れていても・空でも落ちない", () => {
    expect(callShell("plan_base_sha_from_comments", "not json")).toBe("");
    expect(callShell("plan_base_sha_from_comments", "")).toBe("");
  });
});

describe("plan_base_changes", () => {
  let repo: string;
  let firstSha: string;
  let tipSha: string;

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
  }

  function commit(message: string): string {
    writeFileSync(path.join(repo, "file.txt"), message, "utf-8");
    git("add", "file.txt");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  }

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "plan-base-"));
    execFileSync("git", ["init", "-q", repo]);
    firstSha = commit("1件目");
    commit("2件目");
    tipSha = commit("3件目");
    // 実際の呼び出しは `origin/<ベースブランチ>` を見るので、リモート追跡refを立てておく
    git("update-ref", "refs/remotes/origin/develop", tipSha);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("前提のSHA以降に入ったコミットを新しい順に返す", () => {
    const out = callShell("plan_base_changes", "", repo, firstSha, "develop");
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("3件目");
    expect(lines[1]).toContain("2件目");
  });

  it("変化が無いときは「変わっていません」と明示する（空を返さない）", () => {
    expect(callShell("plan_base_changes", "", repo, tipSha, "develop")).toContain(
      "origin/develop は変わっていません",
    );
  });

  it("このリポジトリに無いSHAでも止まらず、確認できなかったことを伝える", () => {
    // 他ブランチのコミット・浅いclone・取り違えのいずれでも起こる。**「変化なし」と
    // 取り違えると、前提が崩れていないように見えてしまう**
    const out = callShell("plan_base_changes", "", repo, "0123456789abcdef0123", "develop");
    expect(out).toContain("存在しないため");
  });

  it("ベースブランチのrefが無くても止まらない", () => {
    expect(callShell("plan_base_changes", "", repo, firstSha, "no-such-branch")).toContain(
      "取得できませんでした",
    );
  });

  it("SHAが空なら何も出力しない（マーカーが無いIssue）", () => {
    expect(callShell("plan_base_changes", "", repo, "", "develop")).toBe("");
  });

  it("gitリポジトリでないパスを渡しても止まらない", () => {
    expect(callShell("plan_base_changes", "", tmpdir(), firstSha, "develop")).toContain(
      "存在しないため",
    );
  });

  it("件数が上限を超えたら畳んで残数を出す", () => {
    const out = callShell("plan_base_changes", "", repo, firstSha, "develop", "1");
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("…他1件");
  });
});
