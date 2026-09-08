import { describe, expect, it } from "vitest";

import {
  buildCandidate,
  CANDIDATE_MARKER,
  countByFile,
  daysSinceJstDate,
  detectKnowledgeStall,
  extractPromotionPullRequestUrl,
  groupKnowledgeByDate,
  hasMarkerLine,
  JUDGED_MARKER,
  parseKnowledgeFile,
  parseMemoComment,
  parseVerdictComment,
  sortCandidates,
  sortKnowledgeSections,
  stripCodeFences,
  type KnowledgeCandidate,
  type RawIssue,
} from "@/lib/knowledge-board";

function issue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    repoFullName: "guchi-apps/issue-deck",
    number: 1,
    title: "テストIssue",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    comments: [],
    ...overrides,
  };
}

describe("stripCodeFences", () => {
  it("バッククォート3つの囲みの中を落とす", () => {
    const body = ["外側", "```md", "囲みの中", "```", "外側2"].join("\n");
    expect(stripCodeFences(body)).toBe("外側\n外側2");
  });

  it("バッククォート4つで開いた囲みは、3つでは閉じない（知見メモのテンプレートの形）", () => {
    const body = ["````markdown", "```", "中", "```", "````", "外"].join("\n");
    expect(stripCodeFences(body)).toBe("外");
  });

  it("チルダの囲みも落とす", () => {
    expect(stripCodeFences(["~~~", "中", "~~~", "外"].join("\n"))).toBe("外");
  });
});

describe("hasMarkerLine", () => {
  it("行全体がマーカーなら真", () => {
    expect(hasMarkerLine(`${CANDIDATE_MARKER}\n### 知見`, CANDIDATE_MARKER)).toBe(true);
  });

  it("地の文へインラインコードとして埋め込まれた言及は拾わない", () => {
    const body = "末尾に`<!-- knowledge-candidate -->`を付けてください。";
    expect(hasMarkerLine(body, CANDIDATE_MARKER)).toBe(false);
  });

  it("囲みの中に貼られた書式の説明は拾わない（この仕組みを設計したIssueの形）", () => {
    const body = ["書式は次のとおり。", "````markdown", CANDIDATE_MARKER, "### 見出し", "````"].join(
      "\n",
    );
    expect(hasMarkerLine(body, CANDIDATE_MARKER)).toBe(false);
  });
});

describe("parseMemoComment", () => {
  it("1コメントの複数の`###`見出しを、知見ごとに分ける", () => {
    const body = [
      CANDIDATE_MARKER,
      "### 一つ目の結論",
      "",
      "- 状況: あれ",
      "",
      "### 二つ目の結論",
      "",
      "- 状況: それ",
    ].join("\n");
    expect(parseMemoComment(body).map((m) => m.title)).toEqual([
      "一つ目の結論",
      "二つ目の結論",
    ]);
  });

  it("知見ごとにマーカーを置く書き方でも分けられる", () => {
    const body = [
      CANDIDATE_MARKER,
      "### 一つ目",
      "",
      CANDIDATE_MARKER,
      "### 二つ目",
    ].join("\n");
    expect(parseMemoComment(body).map((m) => m.title)).toEqual(["一つ目", "二つ目"]);
  });

  it("見出しが無ければ太字の1行、それも無ければ本文の冒頭を見出しにする", () => {
    const bold = "**共有ワークフローの参照タグは既存ファイルへ足す**";
    expect(parseMemoComment(`${CANDIDATE_MARKER}\n${bold}\n\n本文`)[0].title).toBe(
      "共有ワークフローの参照タグは既存ファイルへ足す",
    );
    expect(parseMemoComment(`${CANDIDATE_MARKER}\n地の文の結論です。`)[0].title).toBe(
      "地の文の結論です。",
    );
  });

  it("`**知見メモ**`のような前置きだけの行は見出しにしない（実データで最も多い形）", () => {
    const body = [
      "## 知見メモ",
      "",
      "**新規cloneのローカル起動にはフォルダ信頼の確認が要る**",
      "",
      "- 状況: サブPCで新しいリポジトリを開いたとき",
      CANDIDATE_MARKER,
      "<!-- issue-deck-agent:implementer -->",
    ].join("\n");
    expect(parseMemoComment(body).map((m) => m.title)).toEqual([
      "新規cloneのローカル起動にはフォルダ信頼の確認が要る",
    ]);
  });

  it("`**根拠**`のような短い小見出しでは分けない", () => {
    const body = [
      CANDIDATE_MARKER,
      "**設定ファイルを消すときはリポジトリと実機の両方が要る**",
      "",
      "**なぜ非自明か**",
      "",
      "本文",
      "",
      "**根拠**",
      "",
      "本文",
    ].join("\n");
    expect(parseMemoComment(body).map((m) => m.title)).toEqual([
      "設定ファイルを消すときはリポジトリと実機の両方が要る",
    ]);
  });

  it("太字を見出し代わりにした複数の知見は分ける", () => {
    const body = [
      "**知見メモ**",
      "",
      "非自明な点が2つあった。",
      "",
      "**1. `apply.sh`は「削除」を実機へ反映しない**",
      "",
      "本文",
      "",
      "**2. `deploy.yml`は`push: main`を外すだけでは止まらない**",
      "",
      "本文",
      CANDIDATE_MARKER,
    ].join("\n");
    expect(parseMemoComment(body).map((m) => m.title)).toEqual([
      "1. `apply.sh`は「削除」を実機へ反映しない",
      "2. `deploy.yml`は`push: main`を外すだけでは止まらない",
    ]);
  });

  it("マーカーの後ろに役割マーカーだけが残る形を「(本文なし)」として並べない", () => {
    const body = [
      "**共有ワークフローの参照タグは既存ファイルへ足す**",
      "",
      CANDIDATE_MARKER,
      "<!-- issue-deck-agent:implementer -->",
    ].join("\n");
    expect(parseMemoComment(body)).toHaveLength(1);
  });

  it("見出しの中のリンクは表示文字だけにする", () => {
    const body = `${CANDIDATE_MARKER}\n### auto modeは[anthropics/claude-code#43235](https://github.com/anthropics/claude-code/issues/43235)でHaikuでは動かない`;
    expect(parseMemoComment(body)[0].title).toBe(
      "auto modeはanthropics/claude-code#43235でHaikuでは動かない",
    );
  });
});

describe("parseVerdictComment", () => {
  const body = [
    "### 共有知識への格上げ判定",
    "",
    "- ✅ 承認: `github_token`を渡さないと落ちる → `knowledge/github-actions.md`（既存記載を確認）",
    "  - 理由: 別アプリへ差し替えても成立する",
    "- ❌ 却下: 見出しは1つ＝1知見として数えられる",
    "  - 理由: このリポジトリ固有の書式に依存する",
    "",
    "承認分の反映Pull Request: https://github.com/guchi-apps/docs/pull/118",
  ].join("\n");

  it("折り返した理由の続きの行をつなぐ", () => {
    const wrapped = [
      "- ✅ 承認: 結論 → `knowledge/a.md`",
      "  - 理由: 対象アプリを差し替えても成立し、",
      "    2つ以上のアプリに当てはまる",
      "- ❌ 却下: もう一つ",
    ].join("\n");
    expect(parseVerdictComment(wrapped)[0].reason).toBe(
      "対象アプリを差し替えても成立し、2つ以上のアプリに当てはまる",
    );
  });

  it("承認・却下と反映先・理由を取る", () => {
    expect(parseVerdictComment(body)).toEqual([
      {
        verdict: "approved",
        title: "`github_token`を渡さないと落ちる",
        destination: "knowledge/github-actions.md",
        reason: "別アプリへ差し替えても成立する",
      },
      {
        verdict: "rejected",
        title: "見出しは1つ＝1知見として数えられる",
        destination: null,
        reason: "このリポジトリ固有の書式に依存する",
      },
    ]);
  });

  it("反映Pull RequestのURLを取る", () => {
    expect(extractPromotionPullRequestUrl(body)).toBe("https://github.com/guchi-apps/docs/pull/118");
  });

  it("書式どおりでなければ空を返す（呼び出し側が「内訳不明」として扱えるように）", () => {
    expect(parseVerdictComment("判定しました。")).toEqual([]);
  });
});

describe("buildCandidate", () => {
  it("本文にマーカーがあるだけのIssueは候補にしない", () => {
    expect(buildCandidate(issue({ comments: [] }))).toBeNull();
    expect(
      buildCandidate(
        issue({
          comments: [{ body: "`<!-- knowledge-candidate -->`を付けます", createdAt: "2026-09-01T00:00:00Z" }],
        }),
      ),
    ).toBeNull();
  });

  it("判定コメントが無ければ未判定にする", () => {
    const candidate = buildCandidate(
      issue({
        comments: [{ body: `${CANDIDATE_MARKER}\n### 結論`, createdAt: "2026-09-01T00:00:00Z" }],
      }),
    );
    expect(candidate?.verdict).toBe("pending");
    expect(candidate?.memos).toEqual([{ title: "結論" }]);
    expect(candidate?.at).toBe("2026-09-01T00:00:00Z");
  });

  it("判定コメントがあれば内訳と反映PRを持つ", () => {
    const candidate = buildCandidate(
      issue({
        comments: [
          { body: `${CANDIDATE_MARKER}\n### 結論`, createdAt: "2026-09-01T00:00:00Z" },
          {
            body: [
              "- ✅ 承認: 結論 → `knowledge/github-actions.md`",
              "- ❌ 却下: もう一つ",
              "https://github.com/guchi-apps/docs/pull/118",
              JUDGED_MARKER,
            ].join("\n"),
            createdAt: "2026-09-02T00:00:00Z",
          },
        ],
      }),
    );
    expect(candidate?.verdict).toBe("approved");
    expect(candidate?.approvedCount).toBe(1);
    expect(candidate?.rejectedCount).toBe(1);
    expect(candidate?.promotionPullRequestUrl).toBe("https://github.com/guchi-apps/docs/pull/118");
    // 判定済みの並び順の基準は判定コメントの日時
    expect(candidate?.at).toBe("2026-09-02T00:00:00Z");
  });

  it("内訳が取れなくても、マーカーがあれば判定済みのまま（未判定へ落とさない）", () => {
    const candidate = buildCandidate(
      issue({
        comments: [
          { body: `${CANDIDATE_MARKER}\n### 結論`, createdAt: "2026-09-01T00:00:00Z" },
          { body: `判定しました。\n${JUDGED_MARKER}`, createdAt: "2026-09-02T00:00:00Z" },
        ],
      }),
    );
    expect(candidate?.verdict).toBe("rejected");
    expect(candidate?.notes).toEqual([]);
  });
});

describe("sortCandidates", () => {
  function candidate(overrides: Partial<KnowledgeCandidate>): KnowledgeCandidate {
    return {
      repoFullName: "guchi-apps/issue-deck",
      number: 1,
      title: "t",
      htmlUrl: "u",
      memos: [],
      notes: [],
      verdict: "pending",
      approvedCount: 0,
      rejectedCount: 0,
      promotionPullRequestUrl: null,
      at: "2026-09-01T00:00:00Z",
      ...overrides,
    };
  }

  it("未判定が先（古い順）、判定済みが後（新しい順）", () => {
    const sorted = sortCandidates([
      candidate({ number: 1, verdict: "approved", at: "2026-09-01T00:00:00Z" }),
      candidate({ number: 2, verdict: "pending", at: "2026-09-03T00:00:00Z" }),
      candidate({ number: 3, verdict: "approved", at: "2026-09-05T00:00:00Z" }),
      candidate({ number: 4, verdict: "pending", at: "2026-08-20T00:00:00Z" }),
    ]);
    expect(sorted.map((c) => c.number)).toEqual([4, 2, 3, 1]);
  });
});

describe("parseKnowledgeFile", () => {
  const text = [
    "# GitHub Actions上でClaude Codeを動かす際の知見",
    "",
    "[← knowledge索引](README.md)",
    "",
    "## 既定の`GITHUB_TOKEN`では`.github/workflows/`配下へpushできない",
    "",
    "- **状況**: ワークフローファイル自体を変更するIssueを無人実行したとき。",
    "- **結論**: `workflow`スコープを持つPATを`actions/checkout`の`token`へ渡す。",
    "- **確認日**: 2026-08-09",
    "- **出典リポジトリ**: guchi-apps/issue-deck#106",
    "",
    "## 確認日を持たないセクション",
    "",
    "- 本文だけ",
  ].join("\n");

  it("`##`見出しごとに1知見として切り出す", () => {
    const sections = parseKnowledgeFile({ path: "knowledge/github-actions.md", text });
    expect(sections).toHaveLength(2);
    expect(sections[0]).toEqual({
      path: "knowledge/github-actions.md",
      title: "既定の`GITHUB_TOKEN`では`.github/workflows/`配下へpushできない",
      summary: "`workflow`スコープを持つPATを`actions/checkout`の`token`へ渡す。",
      confirmedOn: "2026-08-09",
      source: "guchi-apps/issue-deck#106",
    });
  });

  it("折り返した結論の続きの行をつなぐ", () => {
    const wrapped = [
      "## 見出し",
      "",
      "- **結論**: `workflow`スコープを持つPATを",
      "  `actions/checkout`の`token`へ渡す。",
      "- **確認日**: 2026-08-09",
    ].join("\n");
    expect(parseKnowledgeFile({ path: "knowledge/x.md", text: wrapped })[0].summary).toBe(
      "`workflow`スコープを持つPATを`actions/checkout`の`token`へ渡す。",
    );
  });

  it("確認日・出典が無ければnullで、要約は本文の冒頭で埋める", () => {
    const sections = parseKnowledgeFile({ path: "knowledge/x.md", text });
    expect(sections[1].confirmedOn).toBeNull();
    expect(sections[1].source).toBeNull();
    expect(sections[1].summary).toBe("- 本文だけ");
  });
});

describe("sortKnowledgeSections / groupKnowledgeByDate / countByFile", () => {
  const sections = [
    { path: "knowledge/b.md", title: "B", summary: "", confirmedOn: "2026-08-27", source: null },
    { path: "knowledge/a.md", title: "A", summary: "", confirmedOn: "2026-08-31", source: null },
    { path: "knowledge/a.md", title: "C", summary: "", confirmedOn: null, source: null },
    { path: "knowledge/a.md", title: "D", summary: "", confirmedOn: "2026-08-31", source: null },
  ];

  it("確認日の新しい順、確認日が無いものは末尾", () => {
    expect(sortKnowledgeSections(sections).map((s) => s.title)).toEqual(["A", "D", "B", "C"]);
  });

  it("確認日ごとにまとめる", () => {
    const groups = groupKnowledgeByDate(sections);
    expect(groups.map((g) => [g.date, g.sections.length])).toEqual([
      ["2026-08-31", 2],
      ["2026-08-27", 1],
      [null, 1],
    ]);
  });

  it("ファイル別の件数を多い順で返す", () => {
    expect(countByFile(sections)).toEqual([
      { path: "knowledge/a.md", count: 3 },
      { path: "knowledge/b.md", count: 1 },
    ]);
  });
});

describe("daysSinceJstDate", () => {
  it("日本時間の日付どうしの差を返す（UTCで動く環境でもずれない）", () => {
    // 2026-09-08 08:00 JST（＝前日23:00 UTC）に、2026-08-31との差を見る
    expect(daysSinceJstDate("2026-08-31", Date.parse("2026-09-07T23:00:00Z"))).toBe(8);
  });

  it("同じ日は0", () => {
    expect(daysSinceJstDate("2026-09-08", Date.parse("2026-09-08T00:30:00+09:00"))).toBe(0);
  });

  it("日付でなければnull", () => {
    expect(daysSinceJstDate("2026/09/08")).toBeNull();
  });
});

describe("detectKnowledgeStall", () => {
  const NO_COUNTS = { total: null, unjudged: null, judged: null };

  const sections = [
    { path: "knowledge/a.md", title: "A", summary: "", confirmedOn: "2026-08-27", source: null },
    { path: "knowledge/a.md", title: "B", summary: "", confirmedOn: "2026-08-31", source: null },
  ];

  function pending(at: string): KnowledgeCandidate {
    return {
      repoFullName: "guchi-apps/issue-deck",
      number: 1,
      title: "t",
      htmlUrl: "u",
      memos: [],
      notes: [],
      verdict: "pending",
      approvedCount: 0,
      rejectedCount: 0,
      promotionPullRequestUrl: null,
      at,
    };
  }

  it("いちばん古い未判定が2日より前なら警告する", () => {
    const stall = detectKnowledgeStall(
      [pending("2026-09-01T00:00:00Z")],
      sections,
      { total: 573, unjudged: 373, judged: 200 },
      200,
      new Date("2026-09-08T00:00:00Z"),
    );
    expect(stall).toEqual({
      pendingCount: 1,
      pendingTotal: 373,
      oldestPendingAt: "2026-09-01T00:00:00Z",
      lastPromotedOn: "2026-08-31",
      shouldWarn: true,
      // 判定済みが収集の上限（200）に達している＝窓が埋まっている
      collectWindowSaturated: true,
    });
  });

  it("直近の未判定だけなら警告しない（判定は毎日1回なので当日ぶんは残る）", () => {
    const stall = detectKnowledgeStall(
      [pending("2026-09-08T00:00:00Z")],
      sections,
      NO_COUNTS,
      200,
      new Date("2026-09-08T12:00:00Z"),
    );
    expect(stall.shouldWarn).toBe(false);
  });

  it("未判定が無ければ警告しない", () => {
    expect(detectKnowledgeStall([], sections).shouldWarn).toBe(false);
  });

  it("判定済みが収集の上限に達していなければ、窓は埋まっていない", () => {
    const stall = detectKnowledgeStall([], sections, { total: 250, unjudged: 51, judged: 199 }, 200);
    expect(stall.collectWindowSaturated).toBe(false);
  });

  it("件数が取れなければ窓の判定はしない（誤った警告を出さない）", () => {
    expect(detectKnowledgeStall([], sections, NO_COUNTS, 200).collectWindowSaturated).toBe(false);
    expect(detectKnowledgeStall([], sections).pendingTotal).toBeNull();
  });
});
