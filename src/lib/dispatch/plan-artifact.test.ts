import { describe, expect, it } from "vitest";

import {
  defaultPlanArtifactSourcePath,
  PLAN_ARTIFACT_PLACEHOLDER,
  splitPlanArtifact,
} from "@/lib/dispatch/plan-artifact";
import { SESSION_ARTIFACT_HTML_LIMIT } from "@/lib/dispatch/session-artifact";

/** 計画の体裁（見出し＋アーティファクト）を組み立てる。テストごとに本文だけを差し替える */
function planWith(block: string): string {
  return ["## 要約", "", "**何かをする。**", "", "## アーティファクト", "", block, ""].join("\n");
}

describe("splitPlanArtifact", () => {
  it("フェンスの中身をHTMLとして取り出し、計画本文からは取り除く", () => {
    const plan = planWith(["```artifact", "<title>案</title>", "<main>x</main>", "```"].join("\n"));

    const result = splitPlanArtifact(plan);

    expect(result.artifact?.html).toBe("<title>案</title>\n<main>x</main>");
    expect(result.plan).not.toContain("<main>");
    expect(result.plan).toContain(PLAN_ARTIFACT_PLACEHOLDER);
    // 見出しは残す。**跡が1行も無いと、見出しの下が空になって計画の体裁が崩れる**
    expect(result.plan).toContain("## アーティファクト");
  });

  it("添えられた差し替え先のパスを拾い、その行も本文から取り除く", () => {
    const plan = planWith(
      ["<!-- artifact: /tmp/scratch/design.html -->", "```artifact", "<main>x</main>", "```"].join(
        "\n",
      ),
    );

    const result = splitPlanArtifact(plan);

    expect(result.artifact?.sourcePath).toBe("/tmp/scratch/design.html");
    expect(result.plan).not.toContain("artifact:");
  });

  it("パスが添えられていなければnullを返す（既定は呼び出し側が決める）", () => {
    const plan = planWith(["```artifact", "<main>x</main>", "```"].join("\n"));

    expect(splitPlanArtifact(plan).artifact?.sourcePath).toBeNull();
  });

  it("HTMLに```が含まれていても、長いフェンスなら取り出せる", () => {
    const plan = planWith(
      ["````artifact", "<pre>```</pre>", "````"].join("\n"),
    );

    expect(splitPlanArtifact(plan).artifact?.html).toBe("<pre>```</pre>");
  });

  it("`html`のコードブロックは取り込まない（計画中の説明を巻き添えにしない）", () => {
    const plan = planWith(["```html", "<main>x</main>", "```"].join("\n"));

    const result = splitPlanArtifact(plan);

    expect(result.artifact).toBeNull();
    expect(result.plan).toBe(plan);
  });

  it("埋め込みが無い計画はそのまま返す", () => {
    const plan = "## 要約\n\n**何かをする。**";

    expect(splitPlanArtifact(plan)).toEqual({ plan, artifact: null });
  });

  it("閉じていないフェンスは触らない（計画の後半を削り落とさない）", () => {
    const plan = planWith(["```artifact", "<main>x</main>"].join("\n"));

    const result = splitPlanArtifact(plan);

    expect(result.artifact).toBeNull();
    expect(result.plan).toBe(plan);
  });

  it("中身が空・上限超過のものは取り込まず、計画も触らない", () => {
    const empty = planWith(["```artifact", "", "```"].join("\n"));
    expect(splitPlanArtifact(empty)).toEqual({ plan: empty, artifact: null });

    const tooLarge = planWith(
      ["```artifact", "a".repeat(SESSION_ARTIFACT_HTML_LIMIT + 1), "```"].join("\n"),
    );
    expect(splitPlanArtifact(tooLarge).artifact).toBeNull();
  });

  it("2つ以上あっても最初の1つだけを取り出す", () => {
    const plan = [
      planWith(["```artifact", "<main>1</main>", "```"].join("\n")),
      ["```artifact", "<main>2</main>", "```"].join("\n"),
    ].join("\n");

    const result = splitPlanArtifact(plan);

    expect(result.artifact?.html).toBe("<main>1</main>");
    expect(result.plan).toContain("<main>2</main>");
  });
});

describe("defaultPlanArtifactSourcePath", () => {
  it("Issueごとに1つに定まり、実在のパスと衝突しない形で返す", () => {
    expect(defaultPlanArtifactSourcePath("guchi-apps/issue-deck", 2200)).toBe(
      "plan-artifact:guchi-apps/issue-deck#2200",
    );
  });
});
