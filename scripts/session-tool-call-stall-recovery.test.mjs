// pollerの`recover_tool_call_stalled_sessions`が「自動で送り直す → 上限で人へ渡す」の順に
// 進むことを固定する（#2896）。
//
// **`subpc-dispatch-poller.sh`はそのままでは読み込めない**（末尾で常駐ループに入る）ので、
// `session-recovery-instruction.test.mjs`と同じくこの関数の定義だけを切り出し、外の世界に
// 触る部分（tmuxの一覧・検知・送出・引き上げ）をスタブへ差し替えて呼ぶ。
//
// ここが緩むと、直らないセッションへ固定文面を送り続ける（上限が効かない）か、1回も送らない
// まま人へ渡す（`due`が最初から偽）かのどちらかになる。どちらもこの仕組みを入れた意味が消える。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const poller = path.join(repoRoot, "scripts", "subpc-dispatch-poller.sh");
const session = "issue-deck-issue-2896";

let workDir;

/**
 * スタブを差し込んだうえで`recover_tool_call_stalled_sessions`を呼ぶ。
 *
 * `detected`が偽のときは「セッションが自力で動き出した」場合にあたる。
 * 起きたこと（送出・引き上げ）はfd 3へ書き出して集める——標準出力はpollerの進捗表示に
 * 使われているため、そちらへ混ぜると取り出せない。
 */
function runRecovery({ detected = true, deliverStatus = 0, before = "" } = {}) {
  const script = `
set -euo pipefail
source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-state.sh"))}
source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-transcript.sh"))}
source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-resume.sh"))}
source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-tool-call-stall.sh"))}
eval "$(sed -n '/^recover_tool_call_stalled_sessions() {/,/^}/p' ${JSON.stringify(poller)})"

DRY_RUN=0
tmux() { printf '%s\\n' ${JSON.stringify(session)}; }
session_tool_call_stall_detected() { return ${detected ? 0 : 1}; }
resolve_session_repository() { printf 'guchi-apps/issue-deck'; }
deliver_session_instruction() { printf 'SEND [%s] %s\\n' "\${3:-<未指定>}" "$2" >&3; return ${deliverStatus}; }
notify_session_interrupted() { printf 'ESCALATE %s\\n' "$6" >&3; return 0; }

${before}
exec 3>&1
recover_tool_call_stalled_sessions >/dev/null
printf 'STATE %s\\n' "$(session_tool_call_stall_read_state ${session})"
`;
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state") },
  })
    .trim()
    .split("\n");
}

/** 前回の試行を十分に古くしておく（間隔待ちを越えた状態を作る）。 */
function backdate(attempts) {
  return `session_state_write_tool_call_stall ${session} $(( $(date +%s) - 3600 )) ${attempts} 0`;
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "tool-call-stall-recovery-"));
  mkdirSync(path.join(workDir, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("recover_tool_call_stalled_sessions", () => {
  it("検知したら固定文面を送り、試行回数を記録する", () => {
    const out = runRecovery();
    expect(out[0]).toContain("直前の応答はツール呼び出し風のテキストを出力しただけで、");
    expect(out[1]).toMatch(/^STATE \d+ 1 0$/);
  });

  it("許可する状態イベントは画面の停滞パネルと同じ（自動の方だけ厳しくしない）", () => {
    // ここが既定の`Stop`に戻ると、「ボタンなら送れるのに自動では毎回見送られる」状態になる。
    expect(runRecovery()[0]).toMatch(/^SEND \[Stop\|working\] /);
  });

  it("送った直後は間隔が空くまで送り直さない", () => {
    const out = runRecovery({
      before: `session_state_write_tool_call_stall ${session} $(date +%s) 1 0`,
    });
    // 送出も引き上げも起きていない＝残るのは状態の行だけ。
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^STATE \d+ 1 0$/);
  });

  it("上限まで送っても直らなければ、1度だけ人へ引き上げる", () => {
    const out = runRecovery({ before: backdate(2) });
    expect(out[0]).toBe("ESCALATE tool_call_stall");
    expect(out[1]).toMatch(/^STATE \d+ 2 1$/);
  });

  it("引き上げ済みなら何もしない（同じIssueへ何度もコメントしない）", () => {
    const out = runRecovery({
      before: `session_state_write_tool_call_stall ${session} $(( $(date +%s) - 3600 )) 2 1`,
    });
    expect(out[0]).toMatch(/^STATE \d+ 2 1$/);
  });

  it("セッションが自力で動き出したら記録を消す", () => {
    const out = runRecovery({ detected: false, before: backdate(1) });
    expect(out[0]).toBe("STATE 0 0 0");
  });

  it("見送られた（承認プロンプト表示中など）場合も試行として数える", () => {
    // 数えないと、送れない状態が続くセッションへ永久に送り続けることになる。
    // 上限に達すれば人へ渡り、画面の停滞パネルから人が押し直せる。
    const out = runRecovery({ deliverStatus: 1 });
    expect(out[1]).toMatch(/^STATE \d+ 1 0$/);
  });
});
