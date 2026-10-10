import { describe, expect, it } from "vitest";

import { describeReleaseReviewAssignee, resolveReleaseReviewAssignee } from "./release-review-assignee";

describe("resolveReleaseReviewAssignee", () => {
  it("既定はClaude Code（Sonnet）", () => {
    expect(resolveReleaseReviewAssignee(null)).toMatchObject({ agent: "claude", claudeModel: "sonnet", codexModel: null });
  });

  it("推論用モデルがOpusならopusで実行する", () => {
    expect(resolveReleaseReviewAssignee({ appAiModelReasoning: "claude-opus-5-5" })).toMatchObject({
      agent: "claude",
      claudeModel: "opus",
    });
  });

  it("OpenAI系モデルならCodex", () => {
    const a = resolveReleaseReviewAssignee({ appAiModelReasoning: "gpt-6-sol" });
    expect(a).toMatchObject({ agent: "codex", codexModel: "gpt-6-sol", claudeModel: null });
    expect(describeReleaseReviewAssignee(a)).toBe("Codex · gpt-6-sol");
  });

  it("主系がcodexで個別指定が無ければCodexの既定", () => {
    expect(resolveReleaseReviewAssignee({ appAiModelReasoning: "inherit", aiExecutionProvider: "codex" }).agent).toBe("codex");
  });

  it("Haikuは使わずSonnetへ読み替える", () => {
    expect(resolveReleaseReviewAssignee({ appAiModelReasoning: "claude-haiku-4-5" }).claudeModel).toBe("sonnet");
  });
});
