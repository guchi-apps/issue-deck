// `scripts/lib/claude-auto-mode-setup.sh`が`~/.claude/settings.json`をどう書き換えるか（#2733）。
//
// ここは**人の個人設定ファイルへ書き込む唯一の場所**なので、次の2つを固定しておく。
//
//   - 壊さない: 既存のキーをそのまま残し、`permissions.defaultMode`の1つだけを足す
//   - 奪わない: 人が選んだ値・人が別のモードを選んでいる状態を上書きしない
//
// 判定に使うのは`CLAUDE_CONFIG_DIR`で差し替えた一時ディレクトリだけで、実物の`~/.claude`は触らない。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libPath = path.join(repoRoot, "scripts/lib/claude-auto-mode-setup.sh");

/** 後片付けの対象。テストごとに作った一時ディレクトリを消す */
const created = [];

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop(), { recursive: true, force: true });
  }
});

/**
 * 設定ディレクトリを1つ用意する。`content`が`undefined`ならファイルを作らない
 * （＝まだ一度も設定を書いていないホスト）。
 */
function makeConfigDir(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-deck-auto-mode-"));
  created.push(dir);
  const configDir = path.join(dir, ".claude");
  fs.mkdirSync(configDir);
  if (content !== undefined) {
    fs.writeFileSync(path.join(configDir, "settings.json"), content);
  }
  return configDir;
}

/**
 * 関数を1回実行し、`{stdout, settings, raw}`を返す。
 * `settings`はJSONとして読めたときだけ入る（壊れた入力を残したかの確認に使う）。
 */
function run(configDir, env = {}) {
  const script = [
    `source ${JSON.stringify(libPath)}`,
    "ensure_claude_auto_mode_default",
  ].join("\n");
  const stdout = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...env },
  });
  const file = path.join(configDir, "settings.json");
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let settings = null;
  try {
    settings = raw === null ? null : JSON.parse(raw);
  } catch {
    settings = null;
  }
  return { stdout, settings, raw };
}

describe("ensure_claude_auto_mode_default（#2733）", () => {
  it("設定ファイルがまだ無ければ、defaultModeだけを持つファイルを作る", () => {
    const configDir = makeConfigDir(undefined);
    const { settings, stdout } = run(configDir);
    expect(settings).toEqual({ permissions: { defaultMode: "auto" } });
    expect(stdout).toContain("permissions.defaultMode");
  });

  it("既存のキーを残したままdefaultModeだけを足す", () => {
    const configDir = makeConfigDir(
      JSON.stringify({ theme: "auto", autoMode: { environment: ["keep me"] } }),
    );
    const { settings } = run(configDir);
    // **他のキーが消えないこと**がこのテストの主眼。個人設定なので失うと戻せない
    expect(settings).toEqual({
      theme: "auto",
      autoMode: { environment: ["keep me"] },
      permissions: { defaultMode: "auto" },
    });
  });

  it("permissionsの他の項目を残す", () => {
    const configDir = makeConfigDir(
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
    );
    const { settings } = run(configDir);
    expect(settings).toEqual({
      permissions: { allow: ["Bash(ls:*)"], defaultMode: "auto" },
    });
  });

  it("既にdefaultModeが入っていれば上書きしない（人の選択を奪わない）", () => {
    const configDir = makeConfigDir(
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
    );
    const { settings, stdout } = run(configDir);
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(stdout).toBe("");
  });

  it("二度実行しても変わらない（冪等）", () => {
    const configDir = makeConfigDir(undefined);
    run(configDir);
    const second = run(configDir);
    expect(second.settings).toEqual({ permissions: { defaultMode: "auto" } });
    // 2回目は何も書かないので案内も出さない
    expect(second.stdout).toBe("");
  });

  it("ISSUE_DECK_CLAUDE_PERMISSION_MODEでauto以外を選んでいれば何も書かない", () => {
    const configDir = makeConfigDir(undefined);
    const { raw } = run(configDir, {
      ISSUE_DECK_CLAUDE_PERMISSION_MODE: "acceptEdits",
    });
    // CLI引数と設定ファイルが食い違ったまま起動しないよう、ファイルごと作らない
    expect(raw).toBeNull();
  });

  it("ISSUE_DECK_SKIP_AUTO_MODE_SETUP=1で丸ごと飛ばせる", () => {
    const configDir = makeConfigDir(undefined);
    const { raw } = run(configDir, { ISSUE_DECK_SKIP_AUTO_MODE_SETUP: "1" });
    expect(raw).toBeNull();
  });

  it("壊れたJSONは触らずに諦める（fail open）", () => {
    const configDir = makeConfigDir("{ broken");
    const { raw, stdout } = run(configDir);
    // 読めないものを書き直すと、人の設定を丸ごと失う。そのまま残す
    expect(raw).toBe("{ broken");
    expect(stdout).toBe("");
  });

  it("permissionsが期待した形でなければ触らない", () => {
    const configDir = makeConfigDir(JSON.stringify({ permissions: "nope" }));
    const { settings } = run(configDir);
    expect(settings).toEqual({ permissions: "nope" });
  });
});
