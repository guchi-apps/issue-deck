import { describe, expect, it } from "vitest";

import {
  canStartPropagation,
  evaluateWorkflowTags,
  extractWorkflowTagRef,
  findWorkflowTagPullRequest,
  isPropagationRunning,
  latestWorkflowTag,
  parseWorkflowTagVersion,
  propagationTargets,
  shortWorkflowTag,
  workflowTagGroup,
  workflowTagPullRequestTitle,
  type WorkflowTagStatus,
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

  it("更新PRを渡せばそのまま持つ（既定は null）", () => {
    const withoutPr = evaluateWorkflowTags(
      "guchi-apps/car-care",
      [ref("workflows/v11")],
      "workflows/v12",
    );
    const withPr = evaluateWorkflowTags(
      "guchi-apps/car-care",
      [ref("workflows/v11")],
      "workflows/v12",
      { number: 42, url: "https://github.com/guchi-apps/car-care/pull/42" },
    );

    expect(withoutPr.updatePullRequest).toBeNull();
    expect(withPr.updatePullRequest?.number).toBe(42);
  });
});

describe("findWorkflowTagPullRequest", () => {
  const pr = (number: number, title: string) => ({
    number,
    title,
    url: `https://github.com/guchi-apps/car-care/pull/${number}`,
  });

  it("最新タグへの更新PRを見つける", () => {
    const found = findWorkflowTagPullRequest(
      [pr(41, "ダッシュボードの表示を直す"), pr(42, workflowTagPullRequestTitle("workflows/v19"))],
      "workflows/v19",
    );

    expect(found).toEqual({
      number: 42,
      url: "https://github.com/guchi-apps/car-care/pull/42",
    });
  });

  it("古いタグへの更新PRは対象にしない", () => {
    // v18へ上げるPRが残ったまま最新がv19になった状態。これを「作成済み」と扱うと、
    // v19への更新が永久に始まらない
    const found = findWorkflowTagPullRequest(
      [pr(42, workflowTagPullRequestTitle("workflows/v18"))],
      "workflows/v19",
    );

    expect(found).toBeNull();
  });

  it("最新タグが分からなければ null", () => {
    expect(
      findWorkflowTagPullRequest([pr(42, workflowTagPullRequestTitle("workflows/v19"))], null),
    ).toBeNull();
  });
});

describe("propagationTargets / workflowTagGroup", () => {
  const status = (overrides: Partial<WorkflowTagStatus>): WorkflowTagStatus => ({
    fullName: "guchi-apps/car-care",
    refs: [],
    outdated: false,
    mismatched: false,
    updatePullRequest: null,
    ...overrides,
  });

  it("更新PRが既にopenのリポジトリは対象から外す", () => {
    // **連続押下の根本対策。** マージされるまで参照タグは古いままなので、除外しないと
    // 押すたびに同じリポジトリへ2本目のPRが作られる（#1602）
    const targets = propagationTargets([
      status({ fullName: "guchi-apps/aide", outdated: true }),
      status({
        fullName: "guchi-apps/car-care",
        outdated: true,
        updatePullRequest: { number: 42, url: "https://example.test/pull/42" },
      }),
    ]);

    expect(targets.map((target) => target.fullName)).toEqual(["guchi-apps/aide"]);
  });

  it("不一致だけのリポジトリも対象に含める", () => {
    const targets = propagationTargets([status({ mismatched: true })]);

    expect(targets).toHaveLength(1);
  });

  it("最新のリポジトリは対象に含めない", () => {
    expect(propagationTargets([status({})])).toHaveLength(0);
  });

  it("グループは 最新 / 更新PR待ち / 未更新 に分かれる", () => {
    expect(workflowTagGroup(status({}))).toBe("latest");
    expect(workflowTagGroup(status({ outdated: true }))).toBe("outdated");
    expect(
      workflowTagGroup(
        status({ outdated: true, updatePullRequest: { number: 1, url: "https://example.test" } }),
      ),
    ).toBe("pull-request");
  });
});

describe("canStartPropagation", () => {
  const run = (status: string, conclusion: string | null = null) => ({
    status,
    conclusion,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    createdAt: "2026-08-15T10:00:00.000Z",
  });

  it("実行中は起動させない", () => {
    // 起動は数秒で返るのにPRが出来上がるまでは数分かかる。その間に押せると二重起動になる
    for (const status of ["queued", "in_progress", "waiting", "requested"]) {
      expect(canStartPropagation(run(status)).allowed, status).toBe(false);
      expect(isPropagationRunning(run(status)), status).toBe(true);
    }
  });

  it("完了していれば起動してよい（成否は問わない）", () => {
    expect(canStartPropagation(run("completed", "success")).allowed).toBe(true);
    expect(canStartPropagation(run("completed", "failure")).allowed).toBe(true);
    expect(isPropagationRunning(run("completed", "failure"))).toBe(false);
  });

  it("1度も動いていなければ起動してよい", () => {
    expect(canStartPropagation(null).allowed).toBe(true);
    expect(isPropagationRunning(null)).toBe(false);
  });
});

describe("shortWorkflowTag", () => {
  it("接頭辞を落として版数だけにする", () => {
    expect(shortWorkflowTag("workflows/v19")).toBe("v19");
  });

  it("形式が違えばそのまま返す", () => {
    expect(shortWorkflowTag("v19")).toBe("v19");
  });
});

describe("タグ作成の版数計算（#1876）", () => {
  it("最新タグの次の版数を求められる", () => {
    // `createNextWorkflowTag`はこの値に1を足して`workflows/vN`を組み立てる
    expect(parseWorkflowTagVersion("workflows/v21")).toBe(21);
    expect(parseWorkflowTagVersion("workflows/v9")).toBe(9);
  });

  it("版数として読めない文字列はnullになる", () => {
    // 読めないまま加算すると`workflows/vNaN`を切ってしまう。呼び出し側はnullで中断する
    expect(parseWorkflowTagVersion("workflows/latest")).toBeNull();
    expect(parseWorkflowTagVersion("v21")).toBeNull();
  });
});
