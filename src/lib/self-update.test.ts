import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 「更新して再起動」の前の作業ツリー確認（`scripts/lib/self-update.sh`・#3588）のテスト。
 *
 * 一番効くのは「**手の変更を消さないこと**」。捨ててよいのは取り込み先（`@{u}`）と完全に
 * 同じ内容のときだけで、それ以外は必ず止まり、画面へ出す理由にファイル名が入ること。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/self-update.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function prepare(dir: string): { status: number | null; stdout: string } {
  const result = spawnSync(
    "bash",
    ["-c", 'set -euo pipefail; source "$0"; self_update_prepare_worktree "$1"', SCRIPT_PATH, dir],
    { encoding: "utf-8" },
  );
  return { status: result.status, stdout: result.stdout };
}

describe("self_update_prepare_worktree", () => {
  let root: string;
  let upstream: string;
  let clone: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "self-update-"));
    const origin = path.join(root, "origin.git");
    upstream = path.join(root, "upstream");
    clone = path.join(root, "clone");
    git(root, "init", "--bare", "-q", "-b", "develop", origin);
    git(root, "clone", "-q", origin, upstream);
    writeFileSync(path.join(upstream, "ports.conf"), "guchi-apps/myroom 13000\n");
    writeFileSync(path.join(upstream, "other.txt"), "a\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "init");
    git(upstream, "push", "-q", "origin", "develop");
    git(root, "clone", "-q", origin, clone);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("きれいな作業ツリーはそのまま続ける", () => {
    expect(prepare(clone)).toEqual({ status: 0, stdout: "" });
  });

  it("取り込み先と同じ内容の変更だけなら捨てて続ける", () => {
    writeFileSync(path.join(upstream, "ports.conf"), "guchi-apps/kurashio 13000\n");
    git(upstream, "commit", "-q", "-am", "rename");
    git(upstream, "push", "-q", "origin", "develop");
    writeFileSync(path.join(clone, "ports.conf"), "guchi-apps/kurashio 13000\n");

    expect(prepare(clone).status).toBe(0);
    expect(git(clone, "status", "--porcelain")).toBe("");
    // 捨てたあとの`pull --ff-only`で同じ内容が入る
    git(clone, "pull", "-q", "--ff-only");
    expect(readFileSync(path.join(clone, "ports.conf"), "utf-8")).toBe("guchi-apps/kurashio 13000\n");
  });

  function pushUpstream(file: string, content: string) {
    writeFileSync(path.join(upstream, file), content);
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", `change ${file}`);
    git(upstream, "push", "-q", "origin", "develop");
  }

  it("取り込みと重ならない変更は残したまま続ける（#4297）", () => {
    pushUpstream("other.txt", "new\n");
    writeFileSync(path.join(clone, "ports.conf"), "guchi-apps/kurashio 13000\n");

    expect(prepare(clone).status).toBe(0);
    git(clone, "pull", "-q", "--ff-only");
    expect(readFileSync(path.join(clone, "ports.conf"), "utf-8")).toBe("guchi-apps/kurashio 13000\n");
    expect(readFileSync(path.join(clone, "other.txt"), "utf-8")).toBe("new\n");
  });

  it("取り込みと同じパスの未追跡ファイルは止める", () => {
    pushUpstream("memo.txt", "up\n");
    writeFileSync(path.join(clone, "memo.txt"), "x\n");

    const result = prepare(clone);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("memo.txt");
  });

  it("取り込み先と違う内容の変更があり、取り込みと重なるなら止め、ファイル名を返す", () => {
    pushUpstream("ports.conf", "guchi-apps/other 14000\n");
    writeFileSync(path.join(clone, "ports.conf"), "guchi-apps/kurashio 13000\n");

    const result = prepare(clone);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("作業ツリーに未コミットの変更があります（ports.conf）。手元で確認してください。");
    // 手の変更は残っている
    expect(readFileSync(path.join(clone, "ports.conf"), "utf-8")).toBe("guchi-apps/kurashio 13000\n");
  });

  it("同じ内容のファイルと違う内容のファイルが混ざっていれば、どちらも捨てずに止める", () => {
    writeFileSync(path.join(upstream, "ports.conf"), "guchi-apps/kurashio 13000\n");
    git(upstream, "commit", "-q", "-am", "rename");
    git(upstream, "push", "-q", "origin", "develop");
    writeFileSync(path.join(clone, "ports.conf"), "guchi-apps/kurashio 13000\n");
    writeFileSync(path.join(clone, "other.txt"), "b\n");

    const result = prepare(clone);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("other.txt");
    expect(readFileSync(path.join(clone, "ports.conf"), "utf-8")).toBe("guchi-apps/kurashio 13000\n");
  });

  it("4件以上はファイル名を3件に縮めて残りを件数で出す", () => {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) {
      pushUpstream(name, "up\n");
      writeFileSync(path.join(clone, name), "x\n");
    }

    expect(prepare(clone).stdout).toBe(
      "作業ツリーに未コミットの変更があります（a.txt, b.txt, c.txt ほか2件）。手元で確認してください。",
    );
  });
});
