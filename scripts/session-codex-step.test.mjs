// `scripts/lib/session-codex-step.sh`が、Codexの転記から作業ステップを`.step`へ書くことを確かめる
// （#3213）。
//
// Codexは`PostToolUse`フックを繋いでおらず、この転記読みが一覧の「実装中(3分)」と進捗バーの
// 調査／実装／検証のマスの唯一の材料になる。形はCodex（0.152.1）の実物に合わせてある:
// ツール呼び出しは`custom_tool_call`・`name=exec`で、`input`にJSのコードが入る。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SESSION = "repo-issue-3213";
const THREAD = "11111111-2222-3333-4444-555555555555";

let workDir;

function record(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

/** `exec`の呼び出し。`input`はCodexが実際に書くJSのコード */
function exec(timestamp, input) {
  return record(timestamp, "response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "call_1",
    input,
  });
}

const cmdCall = (timestamp, cmd) =>
  exec(timestamp, `const r = await tools.exec_command(${JSON.stringify({ cmd, workdir: "/w" })});`);

function writeTranscript(lines) {
  const dir = path.join(workDir, "codex-sessions", "2026", "09", "20");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-20T05-00-00-${THREAD}.jsonl`);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

function runBash(script, env = {}) {
  const preamble = ["session-state.sh", "session-step.sh", "session-transcript.sh", "session-codex-step.sh"]
    .map((name) => `source ${JSON.stringify(path.join(repoRoot, "scripts/lib", name))}`)
    .join("\n");
  return execFileSync("bash", ["-c", `${preamble}\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state"),
      CODEX_SESSIONS_DIR: path.join(workDir, "codex-sessions"),
      ...env,
    },
  });
}

/** 状態ファイルの準備（Codexのセッションで、UUIDが分かっている） */
function prepareState() {
  runBash(`
    session_state_write_codex_thread ${JSON.stringify(SESSION)} ${THREAD}
    session_state_write_descriptor ${JSON.stringify(SESSION)} /tmp/w guchi-apps/repo 3213 0 implementation codex
  `);
}

function readStep() {
  try {
    return readFileSync(path.join(workDir, "state", `${SESSION}.step`), "utf8").trim();
  } catch {
    return null;
  }
}

/** 同期して、書かれたステップ（コードだけ）と見た時刻を返す */
function sync() {
  runBash(`session_codex_step_sync ${JSON.stringify(SESSION)}`);
  const line = readStep();
  if (!line) return null;
  const [entered, step, seen] = line.split(/\s+/);
  return { entered: Number(entered), step, seen: Number(seen) };
}

const epoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "codex-step-"));
  prepareState();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("session_codex_step_sync（#3213）", () => {
  it.each([
    ["pnpm lint", "LINTING"],
    ["pnpm typecheck", "TYPECHECKING"],
    ["pnpm test", "TESTING"],
    ["cd /w && pnpm run build", "BUILDING"],
    ["git add -A && git commit -m x", "COMMITTING"],
    ["git push -u origin issue-1", "PUSHING"],
    ["gh pr create --base develop", "PR"],
    ["gh issue comment 1 --body ok", "ISSUE"],
    ["sed -n '1,80p' src/a.ts", "EXPLORING"],
    ["node scripts/whatever.mjs", "RUNNING"],
  ])("`%s`は%s", (cmd, expected) => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", cmd)]);
    expect(sync()?.step).toBe(expected);
  });

  it("apply_patchはEDITING（同じ呼び出しにコマンドがあっても書き換えを優先する）", () => {
    const input =
      'const patch = "*** Begin Patch\\n*** Add File: a.md\\n+x\\n*** End Patch\\n";\n' +
      'const r = await tools.exec_command({cmd:"git status"});\nawait tools.apply_patch(patch);';
    writeTranscript([exec("2026-09-20T05:00:10.000Z", input)]);
    expect(sync()?.step).toBe("EDITING");
  });

  // コマンドを持たない呼び出しでも落とさない（jqの`capture`は不一致だと出力ごと消える）
  it("コマンドを持たないapply_patchだけの呼び出しもEDITING", () => {
    const input = 'const patch = "*** Begin Patch\\n*** Update File: a.ts\\n*** End Patch\\n";\nawait tools.apply_patch(patch);';
    writeTranscript([cmdCall("2026-09-20T05:00:05.000Z", "pnpm test"), exec("2026-09-20T05:00:10.000Z", input)]);
    expect(sync()?.step).toBe("EDITING");
  });

  it("キーが引用符なしの書き方（{cmd:…}）とPromise.allも読む", () => {
    const input = 'const r = await Promise.all([tools.exec_command({cmd:"pnpm test",workdir:"/w"}), tools.exec_command({cmd:"ls"})]);';
    writeTranscript([exec("2026-09-20T05:00:10.000Z", input)]);
    expect(sync()?.step).toBe("TESTING");
  });

  it("エスケープされた改行の後ろのコマンドも語として読む", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "cd /w\npnpm lint")]);
    expect(sync()?.step).toBe("LINTING");
  });

  it("見た時刻は転記のレコードの時刻（pollerが巡回した時刻ではない）", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.123Z", "pnpm test")]);
    const result = sync();
    expect(result?.seen).toBe(epoch("2026-09-20T05:00:10Z"));
    expect(result?.entered).toBe(epoch("2026-09-20T05:00:10Z"));
  });

  it("直近の呼び出しを採り、走っているコマンドへの入力（write_stdin）は無視して直前を残す", () => {
    writeTranscript([
      cmdCall("2026-09-20T05:00:10.000Z", "pnpm test"),
      exec("2026-09-20T05:00:40.000Z", "const r = await tools.write_stdin({session_id:1,chars:\"\"});"),
    ]);
    // 直近のレコードはwrite_stdinで、作業の種類を表さない＝何も書かない
    expect(sync()).toBeNull();
  });

  it("同じステップが続けば入った時刻は据え置き、見た時刻だけ進む", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "pnpm test")]);
    const first = sync();
    writeTranscript([
      cmdCall("2026-09-20T05:00:10.000Z", "pnpm test"),
      cmdCall("2026-09-20T05:03:10.000Z", "pnpm vitest run"),
    ]);
    const second = sync();
    expect(second?.step).toBe("TESTING");
    expect(second?.entered).toBe(first?.entered);
    expect(second?.seen).toBe(epoch("2026-09-20T05:03:10Z"));
  });

  it("ステップが変われば入った時刻も新しくなる", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "pnpm test")]);
    sync();
    writeTranscript([
      cmdCall("2026-09-20T05:00:10.000Z", "pnpm test"),
      cmdCall("2026-09-20T05:04:00.000Z", "git commit -m x"),
    ]);
    const result = sync();
    expect(result?.step).toBe("COMMITTING");
    expect(result?.entered).toBe(epoch("2026-09-20T05:04:00Z"));
  });

  // 画面の返事を待って止まるコマンド。「コマンド実行中」と出すと人を待っていることが隠れる
  it("submit-plan.shは何も書かない", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "scripts/submit-plan.sh plan.md")]);
    expect(sync()).toBeNull();
  });

  it("codex-artifact.shはARTIFACT", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "scripts/lib/codex-artifact.sh a.html")]);
    expect(sync()?.step).toBe("ARTIFACT");
  });

  it("本文に`custom_tool_call`という語が出るだけのレコードは呼び出しとして数えない", () => {
    writeTranscript([
      cmdCall("2026-09-20T05:00:10.000Z", "pnpm lint"),
      record("2026-09-20T05:01:00.000Z", "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: 'payload.type == "custom_tool_call" を見る' }],
      }),
    ]);
    expect(sync()?.step).toBe("LINTING");
  });

  it("壊れた行・読めない形では何も書かない（従来の表示へ戻る）", () => {
    writeTranscript(['{"timestamp":"2026-09-20T05:00:10.000Z","type":"response_item","payload":{"type":"custom_tool_call"', "not json"]);
    expect(sync()).toBeNull();
  });

  it("Claude Codeのセッションでは何もしない", () => {
    runBash(
      `session_state_write_descriptor ${JSON.stringify(SESSION)} /tmp/w guchi-apps/repo 3213 0 implementation claude`,
    );
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "pnpm test")]);
    expect(sync()).toBeNull();
  });

  it("スイッチで止められる", () => {
    writeTranscript([cmdCall("2026-09-20T05:00:10.000Z", "pnpm test")]);
    runBash(`session_codex_step_sync ${JSON.stringify(SESSION)}`, { SESSION_CODEX_STEP_ENABLED: "0" });
    expect(readStep()).toBeNull();
  });
});
