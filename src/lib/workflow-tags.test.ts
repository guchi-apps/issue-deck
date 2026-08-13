import { describe, expect, it } from "vitest";

import {
  evaluateWorkflowTags,
  extractWorkflowTagRef,
  latestWorkflowTag,
  parseWorkflowTagVersion,
} from "@/lib/workflow-tags";

// 実際の caller の形（guchi-apps/car-care の claude-issue-dispatch.yml より）
const CALLER = `name: Claude Issue Dispatch

# \`uses:\`のタグと\`prompts-ref\`は必ず同じ値にする。\`uses:\`だけ上げるとプロンプトが
# 古いまま使われる。参考: uses: guchi-apps/issue-deck/...@workflows/v1
on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v12
    with:
      runtime-setup: node-db
      prompts-ref: workflows/v12
    secrets: inherit
`;

describe("parseWorkflowTagVersion", () => {
  it("版数を取り出す", () => {
    expect(parseWorkflowTagVersion("workflows/v12")).toBe(12);
    expect(parseWorkflowTagVersion("workflows/v1")).toBe(1);
  });

  it("形式が違えば null", () => {
    for (const tag of ["workflows/v", "v12", "workflows/12", "workflows/v12.1", ""]) {
      expect(parseWorkflowTagVersion(tag), tag).toBeNull();
    }
  });
});

describe("latestWorkflowTag", () => {
  it("版数が最大のものを返す（文字列順ではない）", () => {
    // 文字列順だと v9 > v12 になってしまう。実際 v9 と v12 が併存している
    expect(latestWorkflowTag(["workflows/v9", "workflows/v12", "workflows/v10"])).toBe(
      "workflows/v12",
    );
  });

  it("形式の違うタグを無視する", () => {
    expect(latestWorkflowTag(["v3.1.3", "workflows/v2", "release/v1"])).toBe("workflows/v2");
  });

  it("該当が無ければ null", () => {
    expect(latestWorkflowTag(["v3.1.3", "release/v1"])).toBeNull();
  });
});

describe("extractWorkflowTagRef", () => {
  it("uses と prompts-ref を取り出す", () => {
    expect(extractWorkflowTagRef("claude-issue-dispatch.yml", CALLER)).toEqual({
      file: "claude-issue-dispatch.yml",
      uses: "workflows/v12",
      promptsRef: "workflows/v12",
    });
  });

  it("コメント行の uses: を拾わない", () => {
    // 上のCALLERはコメント内に `uses: ...@workflows/v1` を含む。行頭が uses: の実体だけを見る
    const ref = extractWorkflowTagRef("claude-issue-dispatch.yml", CALLER);

    expect(ref?.uses).not.toBe("workflows/v1");
  });

  it("prompts-ref を持たないワークフローでは null", () => {
    const source = `jobs:
  labels:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-labels.yml@workflows/v12
    secrets: inherit
`;
    expect(extractWorkflowTagRef("issue-labels.yml", source)).toEqual({
      file: "issue-labels.yml",
      uses: "workflows/v12",
      promptsRef: null,
    });
  });

  it("共有ワークフローを参照していないファイルは null", () => {
    const source = `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    expect(extractWorkflowTagRef("ci.yml", source)).toBeNull();
  });
});

describe("evaluateWorkflowTags", () => {
  const ref = (uses: string, promptsRef: string | null = uses) => ({
    file: "claude-issue-dispatch.yml",
    uses,
    promptsRef,
  });

  it("最新と同じなら異常なし", () => {
    const status = evaluateWorkflowTags("guchi-apps/car-care", [ref("workflows/v12")], "workflows/v12");

    expect(status.outdated).toBe(false);
    expect(status.mismatched).toBe(false);
  });

  it("最新より古ければ outdated", () => {
    const status = evaluateWorkflowTags("guchi-apps/car-care", [ref("workflows/v11")], "workflows/v12");

    expect(status.outdated).toBe(true);
  });

  it("1ファイルでも古ければ outdated", () => {
    // v11・v12 が混在する状態。実際 v10 のとき car-care だけ上げて他が v9 のままだった
    const status = evaluateWorkflowTags(
      "guchi-apps/car-care",
      [ref("workflows/v12"), ref("workflows/v11")],
      "workflows/v12",
    );

    expect(status.outdated).toBe(true);
  });

  it("uses と prompts-ref が食い違えば mismatched", () => {
    // **古いかどうかとは別種の異常。** 新しいワークフローで古いプロンプトが動く
    const status = evaluateWorkflowTags(
      "guchi-apps/car-care",
      [ref("workflows/v12", "workflows/v11")],
      "workflows/v12",
    );

    expect(status.outdated).toBe(false);
    expect(status.mismatched).toBe(true);
  });

  it("最新タグが分からないときは outdated と判定しない", () => {
    // タグ取得に失敗した場合に「全部古い」と表示すると、誤って一斉配布を促してしまう
    const status = evaluateWorkflowTags("guchi-apps/car-care", [ref("workflows/v11")], null);

    expect(status.outdated).toBe(false);
  });
});
