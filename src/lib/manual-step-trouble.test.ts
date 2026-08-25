import { describe, expect, it } from "vitest";

import {
  buildManualStepTroubleComment,
  describeManualStepTroubleCategory,
  parseManualStepTroubleComments,
  type ManualStepTroubleRecord,
} from "@/lib/manual-step-trouble";

const base: ManualStepTroubleRecord = {
  stepOrder: 2,
  stepCount: 4,
  stepText: "（ブラウザ）1Passwordで「新規アイテム」から aide-bot の項目を作る",
  category: "display",
  detail: "1Passwordの画面に「新規アイテム」がありません。右上に「＋」があるだけでした。",
};

describe("buildManualStepTroubleComment", () => {
  it("手順・分類・起きたことを書き、目印を末尾に付ける", () => {
    const body = buildManualStepTroubleComment(base);
    expect(body).toContain("- つまずいたところ: 手順 2 / 4");
    expect(body).toContain("- 分類: 外部ツールの表示が違う");
    expect(body).toContain("- 起きたこと: 1Passwordの画面に");
    expect(body.trimEnd().endsWith("<!-- manual-step-trouble:2:display -->")).toBe(true);
  });

  it("完了の確認方法でのつまずきは手順番号を持たない", () => {
    const body = buildManualStepTroubleComment({
      ...base,
      stepOrder: null,
      stepCount: null,
      stepText: "",
      category: null,
    });
    expect(body).toContain("- つまずいたところ: 完了の確認方法");
    expect(body).not.toContain("- 分類:");
    expect(body.trimEnd().endsWith("<!-- manual-step-trouble:: -->")).toBe(true);
  });

  it("貼り付けた出力を入れる場所を持たない（シークレットが混ざりうるため）", () => {
    const body = buildManualStepTroubleComment(base);
    expect(body).toContain("シークレットが混ざりうるためここには残していません");
  });
});

describe("parseManualStepTroubleComments", () => {
  it("書いたコメントをそのまま読み直せる", () => {
    const records = parseManualStepTroubleComments([
      { body: "関係のないコメント" },
      { body: buildManualStepTroubleComment(base) },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].stepOrder).toBe(2);
    expect(records[0].category).toBe("display");
    expect(records[0].detail).toContain("1Passwordの画面に");
  });

  it("目印が無いコメント・起きたことが空のコメントは読まない", () => {
    const records = parseManualStepTroubleComments([
      { body: "⚠️ 手作業でつまずきました。\n\n- 起きたこと: 目印がない" },
      { body: "- 起きたこと: \n\n<!-- manual-step-trouble:1:output -->" },
    ]);
    expect(records).toEqual([]);
  });

  it("知らない分類は分類なしとして読む", () => {
    const records = parseManualStepTroubleComments([
      { body: "- 起きたこと: なにか\n\n<!-- manual-step-trouble:1:unknown -->" },
    ]);
    expect(records[0].category).toBeNull();
  });
});

describe("describeManualStepTroubleCategory", () => {
  it("分類なしはnullを返す", () => {
    expect(describeManualStepTroubleCategory(null)).toBeNull();
    expect(describeManualStepTroubleCategory("output")).toBe("コマンドの出力が違う");
  });
});
