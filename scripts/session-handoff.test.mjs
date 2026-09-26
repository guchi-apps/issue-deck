// `scripts/lib/session-handoff.sh`（別のAIへ引き継ぐときの要約）を、転記とgitリポジトリを
// 一時ディレクトリに作って実行する（#3496）。
//
// 確かめるのは境界だけ: 転記の形式（Claude・Codex）から人とAIの文章だけが残ること、長さの上限が
// 直近を優先して効くこと、転記が引けなくても要約が書けること、そして**起動プロンプトへの追記が
// このIssueの分のファイルに限られる**こと。tmuxやpollerの起動そのものはここでは動かせない。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libPath = path.join(repoRoot, "scripts/lib/session-handoff.sh");

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-handoff-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** ライブラリを読み込んだうえで`script`を実行し、標準出力を返す。転記の場所を引く関数は差し替える */
function run(script, env = {}) {
  return execFileSync("bash", ["-c", `source ${libPath}\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, ISSUE_DECK_HANDOFF_DIR: path.join(workDir, "handoff"), ...env },
  });
}

function writeJsonl(name, records) {
  const file = path.join(workDir, name);
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return file;
}

const claudeText = (type, text, extra = {}) => ({
  type,
  message: { role: type, content: [{ type: "text", text }] },
  ...extra,
});

describe("session_handoff_extract_turns", () => {
  it("Claudeの転記から人とAIの文章だけを取り出す", () => {
    const file = writeJsonl("claude.jsonl", [
      { type: "user", message: { role: "user", content: "最初の依頼です" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "調べます" },
            { type: "tool_use", name: "Read" },
          ],
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
      { type: "user", message: { role: "user", content: "<system-reminder>除外</system-reminder>" } },
      claudeText("assistant", "サブエージェントの発言", { isSidechain: true }),
      claudeText("assistant", "実装しました"),
    ]);
    const out = run(`session_handoff_extract_turns ${file} claude`);
    expect(out).toContain("[user]\n最初の依頼です");
    expect(out).toContain("[assistant]\n調べます");
    expect(out).toContain("実装しました");
    expect(out).not.toContain("除外");
    expect(out).not.toContain("サブエージェント");
    expect(out).not.toContain("tool_use");
  });

  it("Codexの転記（response_item）からも取り出す", () => {
    const file = writeJsonl("codex.jsonl", [
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codexへの依頼" }] },
      },
      { type: "response_item", payload: { type: "function_call", name: "shell" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codexの返答" }],
        },
      },
    ]);
    const out = run(`session_handoff_extract_turns ${file} codex`);
    expect(out).toContain("[user]\nCodexへの依頼");
    expect(out).toContain("[assistant]\nCodexの返答");
    expect(out).not.toContain("shell");
  });

  it("件数の上限は末尾（直近）を残す", () => {
    const file = writeJsonl(
      "many.jsonl",
      Array.from({ length: 5 }, (_, i) => claudeText("assistant", `発言${i + 1}`)),
    );
    const out = run(`session_handoff_extract_turns ${file} claude`, { SESSION_HANDOFF_TURNS: "2" });
    expect(out).toContain("発言5");
    expect(out).toContain("発言4");
    expect(out).not.toContain("発言3");
  });

  it("1件の長さの上限を超える発言は省略する", () => {
    const file = writeJsonl("long.jsonl", [claudeText("assistant", "あ".repeat(50))]);
    const out = run(`session_handoff_extract_turns ${file} claude`, {
      SESSION_HANDOFF_TURN_CHARS: "10",
    });
    expect(out).toContain("あ".repeat(10));
    expect(out).not.toContain("あ".repeat(11));
    expect(out).toContain("長いため省略");
  });

  it("壊れた行・存在しないファイルでは何も出さず失敗もしない", () => {
    const file = path.join(workDir, "broken.jsonl");
    writeFileSync(file, "これはJSONではない\n{途中で切れ\n");
    expect(run(`session_handoff_extract_turns ${file} claude`).trim()).toBe("");
    expect(run(`session_handoff_extract_turns ${path.join(workDir, "none.jsonl")} claude`).trim()).toBe("");
  });
});

describe("session_handoff_build", () => {
  function initRepo() {
    const dir = path.join(workDir, "repo");
    mkdirSync(dir);
    const git = (...args) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init", "-q", "-b", "issue-1");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(path.join(dir, "a.txt"), "a");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    writeFileSync(path.join(dir, "b.txt"), "未コミット");
    return dir;
  }

  it("転記の抜粋とブランチの状態を書き、生の転記は既定では添えない", () => {
    const transcript = writeJsonl("t.jsonl", [claudeText("assistant", "ここまで実装しました")]);
    const repo = initRepo();
    const out = path.join(workDir, "out", "handoff.md");
    run(
      `session_transcript_path() { printf '%s' ${transcript}; }
       session_handoff_build claude sess ${repo} ${out} 0`,
    );
    const body = readFileSync(out, "utf8");
    expect(body).toContain("## 前のセッションからの引き継ぎ");
    expect(body).toContain("ここまで実装しました");
    expect(body).toContain("ブランチ: issue-1");
    expect(body).toContain("b.txt");
    expect(existsSync(path.join(workDir, "out", "handoff.transcript.jsonl"))).toBe(false);
  });

  it("生の転記を添えると、コピーのパスを要約に書く", () => {
    const transcript = writeJsonl("t.jsonl", [claudeText("assistant", "本文")]);
    const out = path.join(workDir, "out", "handoff.md");
    run(
      `session_transcript_path() { printf '%s' ${transcript}; }
       session_handoff_build claude sess ${workDir} ${out} 1`,
    );
    const copy = path.join(workDir, "out", "handoff.transcript.jsonl");
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain(copy);
  });

  it("転記を引けなくても要約は書け、その旨を残す", () => {
    const out = path.join(workDir, "out", "handoff.md");
    run(`session_transcript_path() { return 1; }
         session_handoff_build codex sess ${workDir} ${out} 0`);
    expect(readFileSync(out, "utf8")).toContain("転記を取得できませんでした");
  });
});

describe("session_handoff_append_to_prompt", () => {
  function setup(issue = "7") {
    const prompt = path.join(workDir, "prompt.md");
    writeFileSync(prompt, "本文\n");
    const file = run(`session_handoff_file_path repo ${issue}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "## 引き継ぎ\n中身\n");
    return { prompt, file };
  }

  it("このIssueの要約ファイルを指しているときだけ追記する", () => {
    const { prompt, file } = setup();
    run(`session_handoff_append_to_prompt ${prompt} repo 7`, { ISSUE_DECK_HANDOFF_FILE: file });
    expect(readFileSync(prompt, "utf8")).toContain("中身");
  });

  it("別のIssueのファイル・任意のパス・未設定では追記しない", () => {
    const { prompt, file } = setup();
    run(`session_handoff_append_to_prompt ${prompt} repo 8`, { ISSUE_DECK_HANDOFF_FILE: file });
    run(`session_handoff_append_to_prompt ${prompt} repo 7`, { ISSUE_DECK_HANDOFF_FILE: "/etc/hostname" });
    run(`session_handoff_append_to_prompt ${prompt} repo 7`, { ISSUE_DECK_HANDOFF_FILE: "" });
    expect(readFileSync(prompt, "utf8")).toBe("本文\n");
  });
});
