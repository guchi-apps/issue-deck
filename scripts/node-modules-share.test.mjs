// `scripts/lib/node-modules-share.sh`のシードと除外を、一時ディレクトリの偽リポジトリで確かめる（#2124）。
//
// 守っているのは**本体チェックアウトを壊さないこと**。ハードリンクで共有したファイルへその場
// 書き込みをするツール（実測では`prisma generate`）があると、worktree側の操作が本体と他worktreeの
// `node_modules`まで書き換える。しかも`node_modules`は`.gitignore`対象なので、gitのどこにも
// 差分として出ない。除外リストが緩んだこと・pnpmのリポジトリまで敷いてしまうこと・既存の
// `node_modules`を上書きすることは、いずれもここで止める。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(repoRoot, "scripts", "lib", "node-modules-share.sh");

let base;

/** 本体チェックアウトを模したツリーを作る。パッケージ1つと、生成物のディレクトリを置く。 */
function makeMainCheckout() {
  const main = path.join(base, "main");
  mkdirSync(path.join(main, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(main, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(path.join(main, "node_modules", ".prisma", "client"), { recursive: true });
  writeFileSync(path.join(main, "node_modules", ".prisma", "client", "schema.prisma"), "// generated\n");
  mkdirSync(path.join(main, "node_modules", ".cache"), { recursive: true });
  writeFileSync(path.join(main, "node_modules", ".cache", "blob"), "cached\n");
  return main;
}

/** ライブラリを読み込んで`seed_node_modules_from_main`を1回呼ぶ。 */
function seed(mainDir, worktreeDir, packageManager) {
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; seed_node_modules_from_main 999 "$2" "$3" "$4"`,
      "bash",
      lib,
      mainDir,
      worktreeDir,
      packageManager,
    ],
    { encoding: "utf8" },
  );
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "node-modules-share-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("seed_node_modules_from_main", () => {
  it("npmのリポジトリでは本体とinodeを共有する（実ディスクを増やさない）", () => {
    const main = makeMainCheckout();
    const worktree = path.join(base, "wt");
    mkdirSync(worktree);

    const result = seed(main, worktree, "npm");
    expect(result.status).toBe(0);

    const seeded = statSync(path.join(worktree, "node_modules", "left-pad", "index.js"));
    const source = statSync(path.join(main, "node_modules", "left-pad", "index.js"));
    expect(seeded.ino).toBe(source.ino);
    expect(seeded.nlink).toBe(2);
  });

  it("生成物のディレクトリは共有せずに捨てる", () => {
    // **ここが緩むと本体が壊れる。** `prisma generate`は`.prisma/client/`の一部を
    // inodeを保ったまま書き換えるため、共有したままスキーマの違うブランチで走らせると
    // 本体チェックアウトの生成物がそのブランチの内容に化ける。
    const main = makeMainCheckout();
    const worktree = path.join(base, "wt");
    mkdirSync(worktree);

    expect(seed(main, worktree, "npm").status).toBe(0);

    expect(existsSync(path.join(worktree, "node_modules", "left-pad"))).toBe(true);
    expect(existsSync(path.join(worktree, "node_modules", ".prisma"))).toBe(false);
    expect(existsSync(path.join(worktree, "node_modules", ".cache"))).toBe(false);
    // 本体側は消さない（捨てるのは複製した側だけ）。
    expect(existsSync(path.join(main, "node_modules", ".prisma"))).toBe(true);
  });

  it("pnpm・bunのリポジトリでは何もしない（自前のストアで共有済み）", () => {
    const main = makeMainCheckout();
    for (const packageManager of ["pnpm", "bun", ""]) {
      const worktree = path.join(base, `wt-${packageManager || "none"}`);
      mkdirSync(worktree);
      expect(seed(main, worktree, packageManager).status).toBe(0);
      expect(existsSync(path.join(worktree, "node_modules"))).toBe(false);
    }
  });

  it("worktreeを再利用する場合（node_modulesが既にある）は触らない", () => {
    // そのブランチで入れた依存が既に入っているため、本体の内容を混ぜると辻褄が合わなくなる。
    const main = makeMainCheckout();
    const worktree = path.join(base, "wt");
    mkdirSync(path.join(worktree, "node_modules"), { recursive: true });
    writeFileSync(path.join(worktree, "node_modules", "marker"), "kept\n");

    expect(seed(main, worktree, "npm").status).toBe(0);

    expect(existsSync(path.join(worktree, "node_modules", "marker"))).toBe(true);
    expect(existsSync(path.join(worktree, "node_modules", "left-pad"))).toBe(false);
  });

  it("本体にnode_modulesが無ければ何もしない", () => {
    const main = path.join(base, "main-empty");
    mkdirSync(main);
    const worktree = path.join(base, "wt");
    mkdirSync(worktree);

    expect(seed(main, worktree, "npm").status).toBe(0);
    expect(existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });
});

describe("node_modules_share_exclude_regex", () => {
  it("除外リストと同じ内容をhardlink(1)向けの正規表現にする", () => {
    // 除外の判断はシードと回収で1か所に持つ。片方だけが緩むとそこが単独の穴になるため、
    // 正規表現がリストから機械的に作られていることを固定する。
    const result = spawnSync(
      "bash",
      ["-c", `source "$1"; printf '%s\\n' "\${NODE_MODULES_SHARE_EXCLUDES[*]}"; node_modules_share_exclude_regex`, "bash", lib],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const [names, regex] = result.stdout.trim().split("\n");
    expect(names.split(" ")).toContain("prisma");
    expect(regex).toBe(`/node_modules/\\.(${names.split(" ").join("|")})/`);
  });
});
