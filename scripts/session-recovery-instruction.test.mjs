// 停滞からの復旧（#2886）で、pollerが許可する状態イベントを広げることを固定する。
//
// **`subpc-dispatch-poller.sh`はそのままでは読み込めない**（末尾で常駐ループに入る）ので、
// `send_session_instruction`の定義だけを切り出し、`deliver_session_instruction`と`report_job`を
// スタブに差し替えて呼ぶ。確かめたいのは1点——**復旧のときだけ`Stop|working`を渡す**こと。
//
// APIエラーで中断したセッションは`Stop`フックが飛ばないまま`working`で止まるため、既定の
// `Stop`だけでは画面のボタンが毎回「セッションが作業中のため送りませんでした」で見送られる。
// つまりこの引数が抜けると、**いちばん困る原因に対してだけ復旧が効かない**状態に戻る。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const poller = path.join(repoRoot, "scripts", "subpc-dispatch-poller.sh");

describe("send_session_instruction", () => {
  it("復旧のときだけ許可する状態イベントに working を足す", () => {
    // スタブが受け取った第3引数（許可する状態イベント）をfd 3へ書き出して集める。
    // 標準出力は`message`として吸われるため、そちらへ出すと取り出せない
    const script = `
set -euo pipefail
eval "$(sed -n '/^send_session_instruction() {/,/^}/p' "${poller}")"
deliver_session_instruction() { printf '%s\\n' "\${3:-<未指定>}" >&3; return 0; }
report_job() { :; }
exec 3>&1
send_session_instruction "job-1" "issue-deck-issue-2886" "本文" true >/dev/null
send_session_instruction "job-1" "issue-deck-issue-2886" "本文" false >/dev/null
send_session_instruction "job-1" "issue-deck-issue-2886" "本文" >/dev/null
`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim().split("\n");
    // 3件目は「古いissue-deckが`recovery`を返さない」場合＝従来どおり`Stop`だけ
    expect(out).toEqual(["Stop|working", "Stop", "Stop"]);
  });
});
