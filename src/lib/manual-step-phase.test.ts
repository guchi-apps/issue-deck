import { describe, expect, it } from "vitest";

import type { ManualStepReports } from "@/lib/manual-step-investigation";
import {
  resolveManualStepPhase,
  resolveManualStepPrimaryAction,
  type ManualStepPhaseInput,
} from "@/lib/manual-step-phase";

const investigation = (user = 0) => ({
  purpose: "DBを作る",
  done: ["DB未作成を確認"],
  auto: ["DB作成"],
  user: Array.from({ length: user }, (_, i) => ({ text: `操作${i}`, command: null })),
});
const passed = { entries: [{ command: "true", exitCode: 0 }], passed: true };
const failed = { entries: [{ command: "false", exitCode: 1 }], passed: false };

function input(
  reports: Partial<ManualStepReports>,
  overrides: Partial<ManualStepPhaseInput> = {},
): ManualStepPhaseInput {
  return {
    reports: {
      investigation: null,
      investigationIndex: -1,
      verification: null,
      verificationIndex: -1,
      ...reports,
    },
    isOpen: true,
    sessionAlive: false,
    jobActive: false,
    questionPending: false,
    questionAnswered: false,
    ...overrides,
  };
}

describe("resolveManualStepPhase（#4426）", () => {
  it("報告もセッションも無ければ調査前", () => {
    expect(resolveManualStepPhase(input({}))).toBe("not_investigated");
  });

  it("セッションかジョブが動いていて質問が無ければAI作業中", () => {
    expect(resolveManualStepPhase(input({}, { jobActive: true }))).toBe("ai_working");
    expect(
      resolveManualStepPhase(
        input({ investigation: investigation(1), investigationIndex: 0 }, { sessionAlive: true }),
      ),
    ).toBe("ai_working");
  });

  it("質問待ちならあなたの操作待ち", () => {
    expect(
      resolveManualStepPhase(
        input({ investigation: investigation(1), investigationIndex: 0 }, { sessionAlive: true, questionPending: true }),
      ),
    ).toBe("user_action");
  });

  it("セッション終了後に操作が残っていればあなたの操作待ち", () => {
    expect(
      resolveManualStepPhase(input({ investigation: investigation(2), investigationIndex: 0 })),
    ).toBe("user_action");
  });

  it("答えた直後でセッションが生きていればAI確認中", () => {
    expect(
      resolveManualStepPhase(
        input({ investigation: investigation(1), investigationIndex: 0 }, { sessionAlive: true, questionAnswered: true }),
      ),
    ).toBe("ai_verifying");
  });

  it("操作が無いままセッションが終わり、検証も無ければ止まっている（完了にしない）", () => {
    expect(
      resolveManualStepPhase(input({ investigation: investigation(0), investigationIndex: 0 })),
    ).toBe("ai_stopped");
  });

  it("最新の完了検証が失敗なら検証失敗", () => {
    expect(
      resolveManualStepPhase(
        input({ investigation: investigation(1), investigationIndex: 0, verification: failed, verificationIndex: 1 }),
      ),
    ).toBe("verify_failed");
  });

  it("最新の完了検証がすべて成功なら完了", () => {
    expect(
      resolveManualStepPhase(
        input({ investigation: investigation(0), investigationIndex: 0, verification: passed, verificationIndex: 1 }),
      ),
    ).toBe("done");
  });

  it("成功した検証より新しい調査があれば、古い成功を完了にしない", () => {
    expect(
      resolveManualStepPhase(
        input({ investigation: investigation(1), investigationIndex: 2, verification: passed, verificationIndex: 1 }),
      ),
    ).toBe("user_action");
  });

  it("検証が成功しないままクローズされたら、完了ではなくクローズ済み", () => {
    expect(resolveManualStepPhase(input({}, { isOpen: false }))).toBe("closed");
  });
});

describe("resolveManualStepPrimaryAction（#4426）", () => {
  it("状態ごとに既存の経路だけを主操作にする", () => {
    expect(resolveManualStepPrimaryAction("not_investigated", false)).toBe("start");
    expect(resolveManualStepPrimaryAction("user_action", true)).toBe("answer_question");
    expect(resolveManualStepPrimaryAction("user_action", false)).toBe("request_check");
    expect(resolveManualStepPrimaryAction("verify_failed", false)).toBe("request_recheck");
    expect(resolveManualStepPrimaryAction("ai_stopped", false)).toBe("request_recheck");
    expect(resolveManualStepPrimaryAction("ai_working", false)).toBe("none");
    expect(resolveManualStepPrimaryAction("ai_verifying", false)).toBe("none");
    expect(resolveManualStepPrimaryAction("done", false)).toBe("none");
  });
});
