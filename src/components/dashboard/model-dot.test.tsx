// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ModelDot } from "@/components/dashboard/model-dot";

afterEach(cleanup);

describe("ModelDot", () => {
  it("モデルが分かれば段の色で塗り、エージェントとモデル名を読み上げる", () => {
    render(<ModelDot agent="claude" model="claude-opus-5" />);
    const dot = screen.getByRole("img", { name: "Claude Opus" });
    expect(dot.style.backgroundColor).toBe("rgb(179, 38, 30)");
  });

  it("起動時のエイリアスは短い名前にバージョンを添えて出す", () => {
    render(<ModelDot agent="claude" model="sonnet" />);
    expect(screen.getByRole("img", { name: "Claude Sonnet 5" })).not.toBeNull();
  });

  it("CodexのGPT-6モデルにも世代名を添えて出す", () => {
    render(<ModelDot agent="codex" model="gpt-6-sol" />);
    expect(screen.getByRole("img", { name: "Codex GPT-6 Sol" })).not.toBeNull();
  });

  it("モデルが分からなければ塗らず、エージェント色の中抜きにする", () => {
    render(<ModelDot agent="codex" model={null} />);
    const dot = screen.getByRole("img", { name: "Codex（モデル未確定）" });
    expect(dot.style.backgroundColor).toBe("");
    expect(dot.style.borderColor).toBe("rgb(15, 107, 72)");
  });
});
