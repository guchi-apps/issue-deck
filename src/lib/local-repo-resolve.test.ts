import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ローカル起動のチェックアウト先の解決（`scripts/lib/local-repo-resolve.sh`）のテスト。
 *
 * 固定したいのは、GitHub上でリポジトリをリネームしたあと、サブPCの対応表
 * （`~/.config/issue-deck/local-repos.conf`）のキーが旧名のまま残っていても、
 * チェックアウトの`origin`から新名を引いて申告・解決できること（#3603。myroom→kurashio）。
 * キーしか見ていなかったため、新名で積まれたジョブがサブPCへ割り当てられなかった。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/local-repo-resolve.sh");

let workDir: string;
let configFile: string;
let renamedCheckout: string;
let plainCheckout: string;
let noRemoteCheckout: string;

function initCheckout(dir: string, originUrl?: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  if (originUrl) execFileSync("git", ["-C", dir, "remote", "add", "origin", originUrl]);
}

function callShell(fn: string, ...args: string[]): string {
  return execFileSync("bash", ["-c", `set -euo pipefail; source "$0"; ${fn} "$@"`, SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ISSUE_DECK_LOCAL_REPOS_CONFIG: configFile },
  });
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "local-repo-resolve-"));
  configFile = path.join(workDir, "local-repos.conf");
  renamedCheckout = path.join(workDir, "myroom");
  plainCheckout = path.join(workDir, "dayspan dir");
  noRemoteCheckout = path.join(workDir, "scratch");
  initCheckout(renamedCheckout, "https://github.com/guchi-apps/kurashio.git");
  initCheckout(plainCheckout, "git@github.com:guchi-apps/dayspan.git");
  initCheckout(noRemoteCheckout);
  writeFileSync(
    configFile,
    [
      "# コメント",
      "",
      `guchi-apps/myroom      ${renamedCheckout}`,
      `guchi-apps/dayspan     ${plainCheckout}  \r`,
      `guchi-apps/scratch     ${noRemoteCheckout}`,
      `guchi-apps/gone        ${path.join(workDir, "missing")}`,
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("local_repo_origin_name", () => {
  it("https・sshのどちらのURLからも owner/repo を取り出す", () => {
    expect(callShell("local_repo_origin_name", renamedCheckout)).toBe("guchi-apps/kurashio\n");
    expect(callShell("local_repo_origin_name", plainCheckout)).toBe("guchi-apps/dayspan\n");
  });

  it("originが無ければ1を返す", () => {
    expect(() => callShell("local_repo_origin_name", noRemoteCheckout)).toThrow();
  });
});

describe("local_repo_resolve_path", () => {
  it("キーの完全一致で引ける（空白を含むパス・CRLFも崩さない）", () => {
    expect(callShell("local_repo_resolve_path", "guchi-apps/myroom")).toBe(`${renamedCheckout}\n`);
    expect(callShell("local_repo_resolve_path", "guchi-apps/dayspan")).toBe(`${plainCheckout}\n`);
  });

  it("キーが旧名のままでも、originが指す新名で引ける", () => {
    expect(callShell("local_repo_resolve_path", "guchi-apps/kurashio")).toBe(`${renamedCheckout}\n`);
  });

  it("どこにも無い名前は1を返す（issue-deckだけは対応表が無くても引ける）", () => {
    expect(() => callShell("local_repo_resolve_path", "guchi-apps/unknown")).toThrow();
    expect(callShell("local_repo_resolve_path", "guchi-apps/issue-deck")).toMatch(/\/apps\/issue-deck\n$/);
  });
});

describe("local_repo_list_names", () => {
  it("originが別の名前を指していれば新名を出し、旧名は出さない", () => {
    const names = callShell("local_repo_list_names").trim().split("\n");
    expect(names).toContain("guchi-apps/kurashio");
    expect(names).not.toContain("guchi-apps/myroom");
    expect(names).toContain("guchi-apps/dayspan");
  });

  it("originを読めない行（remote無し・ディレクトリ無し）はキーのまま出す", () => {
    const names = callShell("local_repo_list_names").trim().split("\n");
    expect(names).toContain("guchi-apps/scratch");
    expect(names).toContain("guchi-apps/gone");
    expect(names).toContain("guchi-apps/issue-deck");
  });
});
