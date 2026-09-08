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

function session(state: DispatchSessionView["state"], host = "subpc") {
  return { host, state };
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

  it("セッションが終了していれば、札を外して無人実行へ引き継ぐ", () => {
    expect(
      resolvePrFixRequestRoute({ labels: labels("11.local"), session: session("EXITED") }),
    ).toEqual({ kind: "handoff", host: "subpc", sessionEnded: true });
  });

  it("セッションの記録が無いときも引き継ぎ側へ倒す（sessionEndedで言い分ける）", () => {
    expect(resolvePrFixRequestRoute({ labels: labels("11.local"), session: null })).toEqual({
      kind: "handoff",
      host: null,
      sessionEnded: false,
    });
  });
});

describe("prFixRequestActionLabel", () => {
  it("押したときに起きることを送り先ごとに言い分ける", () => {
    expect(prFixRequestActionLabel({ kind: "actions" })).toBe("修正を依頼する");
    expect(prFixRequestActionLabel({ kind: "session", host: "subpc" })).toBe("セッションへ送る");
    expect(prFixRequestActionLabel({ kind: "handoff", host: null, sessionEnded: false })).toBe(
      "11.localを外して依頼する",
    );
  });
});

describe("prFixRequestLabels", () => {
  const current = labels("00.check-user", "01.check-merge", "21.plan-required", "11.local");

  it("無人実行・セッションへ送る場合は00.check-userと理由ラベルだけを外す", () => {
    for (const route of [
      { kind: "actions" } as const,
      { kind: "session", host: "subpc" } as const,
    ]) {
      expect(prFixRequestLabels(route, current)).toEqual(["21.plan-required", "11.local"]);
    }
  });

  it("引き継ぐ場合は11.localも外す（コメントより先に外れる）", () => {
    expect(
      prFixRequestLabels({ kind: "handoff", host: "subpc", sessionEnded: true }, current),
    ).toEqual(["21.plan-required"]);
  });
});

describe("PR_FIX_SESSION_INSTRUCTION", () => {
  // 送れる本文かどうかを、受け口（`POST /api/dispatch`）と同じ関数で確かめる。
  // 画面だけ緩いと、押せたのに400で弾かれる（`issue-session-status.tsx`と同じ作法）
  it("受け口の判定をそのまま通る（改行なし・長さの上限内）", () => {
    expect(parseSessionInstruction(PR_FIX_SESSION_INSTRUCTION)).toBe(PR_FIX_SESSION_INSTRUCTION);
  });
});
