import { describe, expect, it } from "vitest";

import {
  canStartPropagation,
  canStartRepairPropagation,
  canStartSharedFilePropagation,
  compareSharedFiles,
  evaluateWorkflowTags,
  findSharedFilePullRequest,
  hasLocalSharedFileContent,
  sharedFileLabel,
  sharedFilePropagationTargets,
  sharedFilePullRequestTitle,
  SHARED_FILE_SPECS,
  findRepairWorkflowPullRequest,
  extractWorkflowTagRef,
  findWorkflowTagPullRequest,
  isPropagationRunning,
  latestWorkflowTag,
  parseWorkflowTagVersion,
  missingRepairWorkflows,
  propagationTargets,
  repairPropagationTargets,
  repairWorkflowLabel,
  repairWorkflowPullRequestTitle,
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
    missingRepairWorkflows: [],
    repairPullRequest: null,
    outdatedSharedFiles: [],
    customizedSharedFiles: [],
    sharedFilePullRequest: null,
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

describe("missingRepairWorkflows", () => {
  it("無人実行のcallerがあれば、自動修復と自動マージ判定を不足として挙げる", () => {
    // 実測のguchi-apps/aideと同じ構成（自動修復も自動マージ判定も1つも無かった）
    const missing = missingRepairWorkflows([
      "ci.yml",
      "issue-labels.yml",
      "claude-issue-dispatch.yml",
    ]);

    expect(missing).toEqual([
      "claude-conflict-resolve.yml",
      "claude-ci-fix.yml",
      "claude-review-develop.yml",
    ]);
  });

  it("claude-review-develop.yml が置かれていれば不足に挙げない", () => {
    // develop向けPRの自動マージ可否を判定する唯一の経路（#1470・#1475）
    const missing = missingRepairWorkflows([
      "claude-issue-dispatch.yml",
      "claude-review-develop.yml",
    ]);

    expect(missing).not.toContain("claude-review-develop.yml");
  });

  it("リリースフローがあれば claude-pr-repair.yml も不足に挙げる", () => {
    // バンプPR・リリースPRを直すワークフローなので、リリースフローが無いと起動対象が無い
    const missing = missingRepairWorkflows([
      "claude-issue-dispatch.yml",
      "release-develop-to-main.yml",
    ]);

    expect(missing).toContain("claude-pr-repair.yml");
  });

  it("無人実行のcallerが無いリポジトリには、1つも配らない", () => {
    // 参照タグも with: の値も写す先が無く、配布スクリプトが`fail`で落ちる（#2303）。
    // 挙げると画面のボタンを押した時点でそのリポジトリぶんが必ず失敗する
    expect(missingRepairWorkflows(["ci.yml", "deploy.yml"])).toEqual([]);
  });

  it("参照タグの配布に加わった vps・subpc を、callerの配布の対象にはしない", () => {
    // #2303で参照タグの対象を広げた結果、この構成が一覧へ出るようになった。
    // `release-develop-to-main.yml`・`deploy.yml`を持つので、`requires`に
    // `claude-issue-dispatch.yml`が無いと`claude-pr-repair.yml`・`deploy-retry.yml`が
    // 不足として挙がってしまう（配布スクリプトは写し元が無く必ず失敗する）
    expect(
      missingRepairWorkflows([
        "ci.yml",
        "claude-review-develop.yml",
        "deploy.yml",
        "issue-labels.yml",
        "release-develop-to-main.yml",
        "sync-secrets.yml",
      ]),
    ).toEqual([]);
  });

  it("`requires`は全部そろって初めて配る", () => {
    // #2303で`requires`を配列にした。`deploy-retry.yml`は`deploy.yml`だけでは配れない
    expect(missingRepairWorkflows(["claude-issue-dispatch.yml"])).not.toContain("deploy-retry.yml");
    expect(missingRepairWorkflows(["deploy.yml"])).not.toContain("deploy-retry.yml");
    expect(missingRepairWorkflows(["claude-issue-dispatch.yml", "deploy.yml"])).toContain(
      "deploy-retry.yml",
    );
  });

  // #2134。本番デプロイが一時的な失敗で落ちたときに拾う唯一の経路
  it("deploy.yml があれば deploy-retry.yml を不足に挙げる", () => {
    expect(missingRepairWorkflows(["claude-issue-dispatch.yml", "deploy.yml"])).toContain(
      "deploy-retry.yml",
    );
  });

  it("deploy.yml が無いリポジトリには deploy-retry.yml を配らない", () => {
    // 購読する対象が無く、置いても一度も発火しない
    expect(missingRepairWorkflows(["claude-issue-dispatch.yml"])).not.toContain("deploy-retry.yml");
  });

  it("既に置かれているものは不足に挙げない", () => {
    const missing = missingRepairWorkflows([
      "claude-issue-dispatch.yml",
      "claude-ci-fix.yml",
      "claude-conflict-resolve.yml",
      "claude-review-develop.yml",
    ]);

    expect(missing).toEqual([]);
  });
});

describe("repairPropagationTargets", () => {
  const status = (overrides: Partial<WorkflowTagStatus>): WorkflowTagStatus => ({
    fullName: "guchi-apps/aide",
    refs: [],
    outdated: false,
    mismatched: false,
    updatePullRequest: null,
    missingRepairWorkflows: [],
    repairPullRequest: null,
    outdatedSharedFiles: [],
    customizedSharedFiles: [],
    sharedFilePullRequest: null,
    ...overrides,
  });

  it("不足があるリポジトリだけを対象にする", () => {
    const targets = repairPropagationTargets([
      status({ fullName: "guchi-apps/aide", missingRepairWorkflows: ["claude-ci-fix.yml"] }),
      status({ fullName: "guchi-apps/dayspan" }),
    ]);

    expect(targets.map((target) => target.fullName)).toEqual(["guchi-apps/aide"]);
  });

  it("配布PRが既にopenのリポジトリは対象から外す", () => {
    // マージされるまでcallerは増えないため、除外しないと押すたびに2本目のPRが作られる
    const targets = repairPropagationTargets([
      status({
        missingRepairWorkflows: ["claude-ci-fix.yml"],
        repairPullRequest: { number: 7, url: "https://example.test/pull/7" },
      }),
    ]);

    expect(targets).toEqual([]);
  });

  it("配布PRはタイトルで見つける（スクリプトの --title と同じ文面）", () => {
    const found = findRepairWorkflowPullRequest([
      { number: 3, title: "別のPR", url: "https://example.test/pull/3" },
      { number: 7, title: repairWorkflowPullRequestTitle(), url: "https://example.test/pull/7" },
    ]);

    expect(found?.number).toBe(7);
  });
});

describe("evaluateWorkflowTags の自動修復まわり", () => {
  it("ファイル名一覧から不足を埋める", () => {
    const status = evaluateWorkflowTags(
      "guchi-apps/aide",
      [{ file: "issue-labels.yml", uses: "workflows/v23", promptsRef: "workflows/v23" }],
      "workflows/v23",
      null,
      { files: ["issue-labels.yml", "claude-issue-dispatch.yml"] },
    );

    expect(status.outdated).toBe(false);
    expect(status.missingRepairWorkflows).toEqual([
      "claude-conflict-resolve.yml",
      "claude-ci-fix.yml",
      "claude-review-develop.yml",
    ]);
  });

  it("ファイル名を渡さなければ不足なしとして扱う", () => {
    const status = evaluateWorkflowTags("guchi-apps/aide", [], "workflows/v23");

    expect(status.missingRepairWorkflows).toEqual([]);
    expect(status.repairPullRequest).toBeNull();
  });
});

describe("canStartRepairPropagation", () => {
  it("配布の実行中は起動させない", () => {
    // 起動は数秒で返るのにPRが出来るまでは数分かかる。その間押せると二重に配られる
    const decision = canStartRepairPropagation({
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://example.test/run",
      createdAt: "2026-08-18T00:00:00Z",
    });

    expect(decision.allowed).toBe(false);
  });

  it("完了していれば起動してよい", () => {
    const decision = canStartRepairPropagation({
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://example.test/run",
      createdAt: "2026-08-18T00:00:00Z",
    });

    expect(decision.allowed).toBe(true);
  });
});

describe("repairWorkflowLabel", () => {
  it("ファイル名を画面向けの説明に変える", () => {
    expect(repairWorkflowLabel("claude-ci-fix.yml")).toBe("develop向けPRのCI失敗修正");
  });

  it("未知のファイル名はそのまま返す", () => {
    expect(repairWorkflowLabel("unknown.yml")).toBe("unknown.yml");
  });
});

/** 配布物のパス。テストでは第1号（`signaly-notify.sh`）を使う */
const SHARED_FILE = SHARED_FILE_SPECS[0]!.path;

describe("hasLocalSharedFileContent", () => {
  it("配布元に無い語があれば真", () => {
    // `guchi-apps/subpc`のコピーにある`NOTIFY_NOTE`のような、そのリポジトリだけの追加
    expect(
      hasLocalSharedFileContent("a\nb\n", 'a\nb\nexport NOTIFY_NOTE="${NOTIFY_NOTE:-}"\n'),
    ).toBe(true);
  });

  it("書き換わっただけの行は真にしない", () => {
    // **行で比べていたときの取りこぼしの本体。** 配布元で`run_url=`の右辺を包んだだけの
    // 変更でも、行の集合で見ると配布先の行が「消える行」になり、実測で16件中16件が
    // 該当して目印にならなかった
    const source = 'run_url="${NOTIFY_RUN_URL:-${GITHUB_SERVER_URL}/${GITHUB_RUN_ID}}"\n';
    const target = 'run_url="${GITHUB_SERVER_URL}/${GITHUB_RUN_ID}"\n';

    expect(hasLocalSharedFileContent(source, target)).toBe(false);
  });

  it("配布元の側にだけある語は数えない", () => {
    // これから増える語であって、消えるものではない
    expect(hasLocalSharedFileContent("alpha\nbeta\n", "alpha\n")).toBe(false);
  });

  it("日本語だけのコメントは語として数えない", () => {
    // 語は識別子・変数名・コマンド名だけを見る（コメントの差だけで警告を出さない）
    expect(hasLocalSharedFileContent("alpha\n", "alpha\n# 説明を足した\n")).toBe(false);
  });
});

describe("compareSharedFiles", () => {
  it("内容が違えば配布対象にする", () => {
    const result = compareSharedFiles({ [SHARED_FILE]: "new" }, { [SHARED_FILE]: "old" });

    expect(result.outdated).toEqual([SHARED_FILE]);
  });

  it("同じ内容ならスキップする", () => {
    // **毎回PRを作らないための本体。** 判定は中身の一致だけで見る
    const result = compareSharedFiles({ [SHARED_FILE]: "same" }, { [SHARED_FILE]: "same" });

    expect(result.outdated).toEqual([]);
  });

  it("配布先に置かれていなければ対象にしない", () => {
    // 呼び出し側のステップが無いリポジトリへスクリプトだけ置いても誰も呼ばない
    const result = compareSharedFiles({ [SHARED_FILE]: "new" }, { [SHARED_FILE]: null });

    expect(result.outdated).toEqual([]);
  });

  it("配布元が読めなければ対象にしない", () => {
    // ここを緩めると、取得が失敗しただけで全リポジトリが配布対象になる
    const result = compareSharedFiles({ [SHARED_FILE]: null }, { [SHARED_FILE]: "old" });

    expect(result.outdated).toEqual([]);
  });

  it("独自の変更があるものを別に挙げる", () => {
    const result = compareSharedFiles(
      { [SHARED_FILE]: "alpha\nbeta\n" },
      { [SHARED_FILE]: "alpha\nNOTIFY_NOTE\n" },
    );

    expect(result.outdated).toEqual([SHARED_FILE]);
    expect(result.customized).toEqual([SHARED_FILE]);
  });

  it("独自の変更が無ければ customized は空", () => {
    const result = compareSharedFiles(
      { [SHARED_FILE]: "alpha\nbeta\ngamma\n" },
      { [SHARED_FILE]: "alpha\nbeta\n" },
    );

    expect(result.outdated).toEqual([SHARED_FILE]);
    expect(result.customized).toEqual([]);
  });
});

describe("evaluateWorkflowTags の配布物まわり（#2240）", () => {
  it("配布物の状況を判定結果へ載せる", () => {
    const status = evaluateWorkflowTags(
      "guchi-apps/subpc",
      [],
      null,
      null,
      {},
      {
        source: { [SHARED_FILE]: "alpha\nbeta\n" },
        target: { [SHARED_FILE]: "alpha\nNOTIFY_NOTE\n" },
      },
    );

    expect(status.outdatedSharedFiles).toEqual([SHARED_FILE]);
    expect(status.customizedSharedFiles).toEqual([SHARED_FILE]);
    expect(status.sharedFilePullRequest).toBeNull();
  });

  it("渡さなければ空になる", () => {
    const status = evaluateWorkflowTags("guchi-apps/aide", [], null);

    expect(status.outdatedSharedFiles).toEqual([]);
    expect(status.customizedSharedFiles).toEqual([]);
  });
});

describe("sharedFilePropagationTargets", () => {
  const status = (overrides: Partial<WorkflowTagStatus>): WorkflowTagStatus => ({
    fullName: "guchi-apps/aide",
    refs: [],
    outdated: false,
    mismatched: false,
    updatePullRequest: null,
    missingRepairWorkflows: [],
    repairPullRequest: null,
    outdatedSharedFiles: [],
    customizedSharedFiles: [],
    sharedFilePullRequest: null,
    ...overrides,
  });

  it("古い配布物があるリポジトリだけを対象にする", () => {
    const targets = sharedFilePropagationTargets([
      status({ fullName: "guchi-apps/aide", outdatedSharedFiles: [SHARED_FILE] }),
      status({ fullName: "guchi-apps/dayspan" }),
    ]);

    expect(targets.map((target) => target.fullName)).toEqual(["guchi-apps/aide"]);
  });

  it("更新PRが既にopenのリポジトリは対象から外す", () => {
    // マージされるまで中身は古いままなので、除外しないと押すたびに2本目のPRが作られる
    const targets = sharedFilePropagationTargets([
      status({
        fullName: "guchi-apps/aide",
        outdatedSharedFiles: [SHARED_FILE],
        sharedFilePullRequest: { number: 7, url: "https://example.test/pr/7" },
      }),
    ]);

    expect(targets).toEqual([]);
  });

  it("独自の変更があっても対象から外さない", () => {
    // 独自の変更があるリポジトリこそ修正が届いていない。消える行はPR本文で人へ見せる
    const targets = sharedFilePropagationTargets([
      status({
        fullName: "guchi-apps/subpc",
        outdatedSharedFiles: [SHARED_FILE],
        customizedSharedFiles: [SHARED_FILE],
      }),
    ]);

    expect(targets.map((target) => target.fullName)).toEqual(["guchi-apps/subpc"]);
  });
});

describe("findSharedFilePullRequest", () => {
  const pr = (number: number, title: string) => ({
    number,
    title,
    url: `https://example.test/pr/${number}`,
  });

  it("配布PRのタイトルで見つける", () => {
    const found = findSharedFilePullRequest([
      pr(1, "別のPR"),
      pr(2, sharedFilePullRequestTitle()),
    ]);

    expect(found).toEqual({ number: 2, url: "https://example.test/pr/2" });
  });

  it("無ければ null", () => {
    expect(findSharedFilePullRequest([pr(1, "別のPR")])).toBeNull();
  });
});

describe("canStartSharedFilePropagation", () => {
  it("実行中は断る", () => {
    const decision = canStartSharedFilePropagation({
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://example.test/run",
      createdAt: "2026-08-24T00:00:00Z",
    });

    expect(decision.allowed).toBe(false);
  });

  it("完了していれば起こしてよい", () => {
    const decision = canStartSharedFilePropagation({
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://example.test/run",
      createdAt: "2026-08-24T00:00:00Z",
    });

    expect(decision.allowed).toBe(true);
  });
});

describe("sharedFileLabel", () => {
  it("パスを画面向けの説明に変える", () => {
    expect(sharedFileLabel(".github/scripts/signaly-notify.sh")).toBe("Signaly通知スクリプト");
  });

  it("未知のパスはそのまま返す", () => {
    expect(sharedFileLabel(".github/scripts/unknown.sh")).toBe(".github/scripts/unknown.sh");
  });
});
