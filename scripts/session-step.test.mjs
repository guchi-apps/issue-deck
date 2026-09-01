// `scripts/lib/session-step.sh`が、フックのJSONからどのステップを決めるかを固定する（#2705）。
//
// ここが崩れると、画面のセッションに「調査中」「Lintチェック中」がずっと出ないか、まったく
// 違うステップが出る。判定はコマンドの文字列を相手にするため、語の一部への誤爆
// （`grep -n "lint"`が「Lintチェック中」になる）が起きやすいところで、その形も一緒に見る。
//
// 語彙そのものは`src/lib/dispatch/session-state.ts`の`SESSION_STEPS`と揃っている必要がある。
// **片方だけ増えるとissue-deck側が知らないコードとして落とす**ので、突き合わせもここで行う。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SESSION_STEPS } from "@/lib/dispatch/session-state";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(repoRoot, "scripts/lib/session-step.sh");

/**
 * bash側の関数を1回実行する。
 *
 * **入力は環境変数で渡す。** スクリプトの文字列へ埋め込むと、`$(whoami)`のような値が関数へ
 * 届く前にbashへ展開され、確かめたいことと逆の結果になる（実物はフックのJSONから取り出した
 * 文字列を変数として受け取るので、そこで展開されることはない）。
 */
function run(snippet, env = {}) {
  const script = [`source ${JSON.stringify(lib)}`, snippet].join("\n");
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function classify(tool, command = "") {
  return run('session_step_classify "$TOOL" "$COMMAND" || printf NONE', {
    TOOL: tool,
    COMMAND: command,
  });
}

describe("session_step_classify（ツール名から）", () => {
  it.each([
    ["ExitPlanMode", "PLANNING"],
    ["Edit", "EDITING"],
    ["Write", "EDITING"],
    ["Read", "EXPLORING"],
    ["Grep", "EXPLORING"],
    ["WebFetch", "EXPLORING"],
    ["Artifact", "ARTIFACT"],
  ])("%s → %s", (tool, expected) => {
    expect(classify(tool)).toBe(expected);
  });

  // 知らないツール（MCP・Skill・AskUserQuestionなど）に当てずっぽうの分類を当てると、
  // 全部が「コマンド実行中」へ落ちる。書き換えずに直前のステップを残す
  it("知らないツールでは何も返さない", () => {
    expect(classify("AskUserQuestion")).toBe("NONE");
    expect(classify("mcp__something__do")).toBe("NONE");
  });
});

describe("session_step_classify（Bashのコマンドから）", () => {
  it.each([
    ["pnpm lint", "LINTING"],
    ["pnpm run lint", "LINTING"],
    ["npx eslint src", "LINTING"],
    ["pnpm typecheck", "TYPECHECKING"],
    ["npx tsc --noEmit", "TYPECHECKING"],
    ["pnpm test", "TESTING"],
    ["pnpm vitest run src/lib/x.test.ts", "TESTING"],
    ["pnpm build", "BUILDING"],
    ["git add -A", "COMMITTING"],
    ["git commit -m 'fix'", "COMMITTING"],
    ["git push -u origin issue-2705", "PUSHING"],
    ["gh pr create --fill", "PR"],
    ["gh issue comment 2705 --body x", "ISSUE"],
    ["gh issue view 2705 --comments", "EXPLORING"],
    ["git log --oneline -5", "EXPLORING"],
    ["cat package.json", "EXPLORING"],
    ["pnpm install", "RUNNING"],
  ])("%s → %s", (command, expected) => {
    expect(classify("Bash", command)).toBe(expected);
  });

  // `cd … && pnpm lint`の形が実際にはいちばん多い
  it("連結したコマンドでも当たる", () => {
    expect(classify("Bash", "cd /tmp/x && pnpm lint")).toBe("LINTING");
  });

  // 語の一部に当てると、検索しているだけのコマンドが検証中に見える
  it("語の一部には当たらない", () => {
    expect(classify("Bash", 'grep -rn "lint" src')).toBe("EXPLORING");
    expect(classify("Bash", "ls src/lib/testing")).toBe("EXPLORING");
  });

  // commitとpushは続けて打つことが多く、先にcommitへ倒すと出ている間ずっと「コミット中」になる
  it("commitとpushを続けて打った場合はpushを採る", () => {
    expect(classify("Bash", "git commit -m x && git push")).toBe("PUSHING");
  });
});

describe("フックのJSONからの取り出し", () => {
  const hook = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm lint", description: "Run lint" },
  });

  it("tool_nameとコマンドの先頭を取り出す", () => {
    expect(run('session_step_hook_tool_name "$JSON"', { JSON: hook })).toBe("Bash");
    expect(run('session_step_hook_command "$JSON"', { JSON: hook })).toBe("pnpm lint");
  });

  it("項目が無ければ非0で返る", () => {
    const empty = JSON.stringify({ hook_event_name: "Stop" });
    expect(run('session_step_hook_tool_name "$JSON" || printf NONE', { JSON: empty })).toBe("NONE");
    expect(run('session_step_hook_command "$JSON" || printf NONE', { JSON: empty })).toBe("NONE");
  });
});

/**
 * `.step`が持つ時刻は2つ（`scripts/lib/session-state.sh`）。**入った時刻は同じコードが続く間は
 * 動かさず、最後に見た時刻はツールの実行ごとに動かす。** 前者が画面の「実装中・2分」、後者が
 * 「いま走っているか」の判定材料で、片方に寄せると必ずどちらかが壊れる。
 */
describe("session_state_write_step（時刻の持ち方）", () => {
  const stateLib = path.join(repoRoot, "scripts/lib/session-state.sh");

  function writeAndRead(steps, dir) {
    const script = [
      `source ${JSON.stringify(stateLib)}`,
      ...steps.flatMap((step) => [`session_state_write_step demo ${step}`, "sleep 1.1"]),
      "session_state_read_step demo",
    ].join("\n");
    return execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, ISSUE_DECK_SESSION_STATE_DIR: dir },
    }).trim();
  }

  it("同じコードが続けば入った時刻は据え置き、最後に見た時刻だけ進む", () => {
    const dir = path.join(repoRoot, "node_modules/.cache/issue-deck-session-step-test/same");
    execFileSync("rm", ["-rf", dir]);
    const [entered, code, seen] = writeAndRead(["EDITING", "EDITING"], dir).split(/\s+/);
    expect(code).toBe("EDITING");
    expect(Number(seen)).toBeGreaterThan(Number(entered));
  });

  it("コードが変われば入った時刻も進む", () => {
    const dir = path.join(repoRoot, "node_modules/.cache/issue-deck-session-step-test/changed");
    execFileSync("rm", ["-rf", dir]);
    const [entered, code, seen] = writeAndRead(["EDITING", "TESTING"], dir).split(/\s+/);
    expect(code).toBe("TESTING");
    expect(Number(seen)).toBe(Number(entered));
  });
});

// **語彙は2箇所にある。** ホスト側が知らないコードを送るとissue-deck側が落とし、画面には
// 何も出ないまま（症状としては「ステップが出ないことがある」だけ）になる
describe("語彙の突き合わせ", () => {
  it("SESSION_STEP_CODESとSESSION_STEPSが一致する", () => {
    const codes = run('printf "%s\\n" "${SESSION_STEP_CODES[@]}"').split("\n");
    expect(codes).toEqual([...SESSION_STEPS]);
  });
});
