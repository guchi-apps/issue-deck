import { describe, expect, it } from "vitest";

import { parseSessionInstruction } from "@/lib/dispatch/dispatch-job";
import {
  PR_FIX_SESSION_INSTRUCTION,
  prFixRequestActionLabel,
  prFixRequestLabels,
  resolvePrFixRequestRoute,
} from "@/lib/dispatch/pr-fix-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "ededed", description: null }));
}

function session(
  state: DispatchSessionView["state"],
  host = "subpc",
  codexThreadKnown: DispatchSessionView["codexThreadKnown"] = null,
) {
  return { host, state, codexThreadKnown };
}

describe("resolvePrFixRequestRoute", () => {
  it("11.localが無ければ無人実行へ送る（セッションの記録が残っていても変えない）", () => {
    // 引き継いだ直後は、セッションの記録（24時間残る）とActionsの実行が重なる。
    // ここでもう一度引き継ごうとすると、外す札がもう無い
    expect(
      resolvePrFixRequestRoute({ labels: labels("51.improvement"), session: session("EXITED") }),
    ).toEqual({ kind: "actions" });
  });

  it("11.localが付いていて、セッションが生きていればそのセッションへ送る", () => {
    expect(
      resolvePrFixRequestRoute({ labels: labels("11.local"), session: session("ALIVE", "subpc") }),
    ).toEqual({ kind: "session", host: "subpc" });
  });

  it("セッションが終了していれば、そのセッションを呼び戻す（札は外さない）", () => {
    // Issue本文の「クローズしていたら再度立ち上げる」。呼び戻す導線は#1830で既にあり、
    // `claude --continue`で前回の会話の続きから再開する
    for (const state of ["EXITED", "FAILED", "GONE"] as const) {
      expect(
        resolvePrFixRequestRoute({ labels: labels("11.local"), session: session(state) }),
      ).toEqual({ kind: "resume", host: "subpc", agent: "claude" });
    }
  });

  it("呼び戻すCLIは終了したセッションのものを引き継ぐ（Codexを黙ってClaude Codeにしない）", () => {
    // `agent`を省くと受け口が既定（claude）へ落とすため、送り先の側で決めておく
    for (const codexThreadKnown of [true, false] as const) {
      expect(
        resolvePrFixRequestRoute({
          labels: labels("11.local"),
          session: session("EXITED", "subpc", codexThreadKnown),
        }),
      ).toEqual({ kind: "resume", host: "subpc", agent: "codex" });
    }
  });

  it("セッションの記録すら無いときだけ、札を外して無人実行へ引き継ぐ", () => {
    expect(resolvePrFixRequestRoute({ labels: labels("11.local"), session: null })).toEqual({
      kind: "handoff",
    });
  });
});

describe("prFixRequestActionLabel", () => {
  it("押したときに起きることを送り先ごとに言い分ける", () => {
    expect(prFixRequestActionLabel({ kind: "actions" })).toBe("修正を依頼する");
    expect(prFixRequestActionLabel({ kind: "session", host: "subpc" })).toBe("セッションへ送る");
    expect(prFixRequestActionLabel({ kind: "resume", host: "subpc", agent: "claude" })).toBe(
      "セッションを再開して依頼する",
    );
    expect(prFixRequestActionLabel({ kind: "handoff" })).toBe("11.localを外して依頼する");
  });
});

describe("prFixRequestLabels", () => {
  const current = labels("00.check-user", "01.check-merge", "21.plan-required", "11.local");

  it("無人実行が担当なら00.check-userと理由ラベルだけを外す", () => {
    expect(prFixRequestLabels({ kind: "actions" }, current)).toEqual([
      "21.plan-required",
      "11.local",
    ]);
  });

  it("サブPCへ積む送り先ではラベルを変えない（届いてから外す）", () => {
    // 積んだ時点で外すと、pollerが見送ったときに何も届いていないのに札だけ消える（#2886と同じ）
    expect(prFixRequestLabels({ kind: "session", host: "subpc" }, current)).toBeNull();
    expect(prFixRequestLabels({ kind: "resume", host: "subpc", agent: "claude" }, current)).toBeNull();
  });

  it("引き継ぐ場合は11.localも外す（コメントより先に外れる）", () => {
    expect(prFixRequestLabels({ kind: "handoff" }, current)).toEqual(["21.plan-required"]);
  });
});

describe("PR_FIX_SESSION_INSTRUCTION", () => {
  // 送れる本文かどうかを、受け口（`POST /api/dispatch`）と同じ関数で確かめる。
  // 画面だけ緩いと、押せたのに400で弾かれる（`issue-session-status.tsx`と同じ作法）
  it("受け口の判定をそのまま通る（改行なし・長さの上限内）", () => {
    expect(parseSessionInstruction(PR_FIX_SESSION_INSTRUCTION)).toBe(PR_FIX_SESSION_INSTRUCTION);
  });
});
