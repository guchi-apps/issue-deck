import { describe, expect, it } from "vitest";

import {
  ISSUE_ORDER_RESULT_LIMIT,
  ISSUE_ORDER_SKIP_LIMIT,
  buildIssueOrderPrompt,
  pickIssueOrder,
  type IssueOrderCandidate,
} from "@/lib/claude/issue-order";

const candidates: IssueOrderCandidate[] = [
  {
    key: "owner/repo#1",
    title: "一覧の絞り込みを共通化する",
    labels: ["50.feature", "80.Priority: High"],
    ageDays: 32,
    bodyHead: "絞り込みの実装が3か所に散っているので1つにまとめる。",
  },
  {
    key: "owner/repo#2",
    title: "ログインできない",
    labels: [],
    ageDays: 2,
    bodyHead: "",
  },
];

const candidateKeys = candidates.map((candidate) => candidate.key);

describe("buildIssueOrderPrompt", () => {
  it("候補のキー・タイトル・ラベル・経過日数・本文の冒頭を含める", () => {
    const prompt = buildIssueOrderPrompt({ candidates });

    expect(prompt).toContain(
      "- owner/repo#1 一覧の絞り込みを共通化する [50.feature, 80.Priority: High] (起票から32日)",
    );
    expect(prompt).toContain("絞り込みの実装が3か所に散っているので1つにまとめる。");
    expect(prompt).toContain("- owner/repo#2 ログインできない (起票から2日)");
  });

  it("着手順と見送り候補の両方を1回で返させる", () => {
    const prompt = buildIssueOrderPrompt({ candidates });

    expect(prompt).toContain('"order"');
    expect(prompt).toContain('"skip"');
    // 断定させないこと（クローズの判断は人が行う）を明示する
    expect(prompt).toContain("断定せず");
  });

  it("本文の改行はプロンプト上の行を崩さないよう1行へ畳む", () => {
    const prompt = buildIssueOrderPrompt({
      candidates: [{ ...candidates[0], bodyHead: "1行目\n\n2行目" }],
    });

    expect(prompt).toContain("1行目 2行目");
  });
});

describe("pickIssueOrder", () => {
  it("全体の方針・着手順・見送り候補を応答の順序で返す", () => {
    const text = JSON.stringify({
      overview: "共通化を先に片付けます。",
      order: [
        { key: "owner/repo#1", reason: "他の前提になっているため" },
        { key: "owner/repo#2", reason: "短時間で終わるため" },
      ],
      skip: [],
    });

    expect(pickIssueOrder(text, candidateKeys)).toEqual({
      overview: "共通化を先に片付けます。",
      order: [
        { key: "owner/repo#1", reason: "他の前提になっているため" },
        { key: "owner/repo#2", reason: "短時間で終わるため" },
      ],
      skip: [],
    });
  });

  it("コードフェンス付きの応答も読む", () => {
    const text = '```json\n{"overview":"","order":[{"key":"owner/repo#1","reason":"先"}],"skip":[]}\n```';

    expect(pickIssueOrder(text, candidateKeys).order).toEqual([
      { key: "owner/repo#1", reason: "先" },
    ]);
  });

  it("候補に無いキーは採らない", () => {
    const text = JSON.stringify({
      order: [{ key: "owner/repo#999", reason: "存在しない" }, { key: "owner/repo#2", reason: "実在" }],
      skip: [{ key: "other/repo#1", reason: "存在しない" }],
    });

    const result = pickIssueOrder(text, candidateKeys);

    expect(result.order).toEqual([{ key: "owner/repo#2", reason: "実在" }]);
    expect(result.skip).toEqual([]);
  });

  it("大文字小文字の違いは同じキーとして扱う", () => {
    const text = JSON.stringify({ order: [{ key: "OWNER/REPO#1", reason: "先" }] });

    expect(pickIssueOrder(text, candidateKeys).order).toEqual([
      { key: "owner/repo#1", reason: "先" },
    ]);
  });

  it("着手順と見送り候補に同じIssueが出てきたら、着手順の方だけ残す", () => {
    const text = JSON.stringify({
      order: [{ key: "owner/repo#1", reason: "先にやる" }],
      skip: [{ key: "owner/repo#1", reason: "やらない" }],
    });

    const result = pickIssueOrder(text, candidateKeys);

    expect(result.order).toEqual([{ key: "owner/repo#1", reason: "先にやる" }]);
    expect(result.skip).toEqual([]);
  });

  it("同じキーの重複は先に出てきた方だけ残す", () => {
    const text = JSON.stringify({
      order: [
        { key: "owner/repo#1", reason: "1回目" },
        { key: "owner/repo#1", reason: "2回目" },
      ],
    });

    expect(pickIssueOrder(text, candidateKeys).order).toEqual([
      { key: "owner/repo#1", reason: "1回目" },
    ]);
  });

  it("理由が欠けていても、キーが実在すれば残す", () => {
    const text = JSON.stringify({ order: [{ key: "owner/repo#1" }] });

    expect(pickIssueOrder(text, candidateKeys).order).toEqual([{ key: "owner/repo#1", reason: "" }]);
  });

  it("JSONとして読めない応答は空の結果にする", () => {
    expect(pickIssueOrder("順番を決められませんでした", candidateKeys)).toEqual({
      overview: "",
      order: [],
      skip: [],
    });
  });

  it("orderやskipが配列でない応答も空の結果にする", () => {
    const text = JSON.stringify({ overview: "方針", order: "1番目", skip: null });

    expect(pickIssueOrder(text, candidateKeys)).toEqual({
      overview: "方針",
      order: [],
      skip: [],
    });
  });

  it("上限を超える件数は切り捨てる", () => {
    const manyKeys = Array.from({ length: 20 }, (_, index) => `owner/repo#${index + 1}`);
    const text = JSON.stringify({
      order: manyKeys.map((key) => ({ key, reason: "理由" })),
      skip: manyKeys.map((key) => ({ key: `owner/repo#${Number(key.split("#")[1]) + 100}`, reason: "理由" })),
    });

    const result = pickIssueOrder(
      text,
      manyKeys.concat(Array.from({ length: 20 }, (_, index) => `owner/repo#${index + 101}`)),
    );

    expect(result.order).toHaveLength(ISSUE_ORDER_RESULT_LIMIT);
    expect(result.skip).toHaveLength(ISSUE_ORDER_SKIP_LIMIT);
  });
});
