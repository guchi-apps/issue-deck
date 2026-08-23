import { describe, expect, it } from "vitest";

import {
  CONSULT_OPENING_MESSAGE,
  MAX_CONSULT_TURNS,
  buildConsultMessages,
  countConsultTurns,
  isConsultExhausted,
  normalizeDraft,
  parseConsultResponse,
  type ConsultMessage,
} from "@/lib/claude/new-app-consult";

function conversation(userTurns: number): ConsultMessage[] {
  const messages: ConsultMessage[] = [{ role: "assistant", content: CONSULT_OPENING_MESSAGE }];
  for (let i = 0; i < userTurns; i += 1) {
    messages.push({ role: "user", content: `発言${i}` });
    messages.push({ role: "assistant", content: `返事${i}` });
  }
  return messages;
}

describe("countConsultTurns / isConsultExhausted", () => {
  it("数えるのはユーザーの発言だけ", () => {
    expect(countConsultTurns(conversation(3))).toBe(3);
  });

  it("上限に達したら打ち切る", () => {
    expect(isConsultExhausted(conversation(MAX_CONSULT_TURNS - 1))).toBe(false);
    expect(isConsultExhausted(conversation(MAX_CONSULT_TURNS))).toBe(true);
  });
});

describe("buildConsultMessages", () => {
  it("画面にだけ出している最初の一言は送らない", () => {
    const sent = buildConsultMessages(conversation(1));
    expect(sent.map((m) => m.content)).toEqual(["発言0", "返事0"]);
  });

  it("空の発言は落とす", () => {
    const sent = buildConsultMessages([
      { role: "user", content: "  " },
      { role: "user", content: "作りたい" },
    ]);
    expect(sent).toEqual([{ role: "user", content: "作りたい" }]);
  });

  it("長すぎる発言は切る", () => {
    const sent = buildConsultMessages([{ role: "user", content: "あ".repeat(5000) }]);
    expect(sent[0].content.length).toBe(2000);
  });
});

describe("normalizeDraft", () => {
  it("扱える値だけを残す", () => {
    expect(
      normalizeDraft({
        displayName: "家計レポート",
        repositoryName: "kakei-report",
        summary: "家計の月次推移",
        kind: "next-db",
        subdomain: "kakei-report",
        auth: "supabase-google",
        usesDatabase: true,
      }),
    ).toEqual({
      displayName: "家計レポート",
      repositoryName: "kakei-report",
      summary: "家計の月次推移",
      kind: "next-db",
      subdomain: "kakei-report",
      auth: "supabase-google",
      usesDatabase: true,
    });
  });

  it("使えないリポジトリ名・サブドメインはnullへ落とす（そのまま初期値にしない）", () => {
    const draft = normalizeDraft({ repositoryName: "My_App", subdomain: "-bad-" });
    expect(draft).toBeNull();
  });

  it("知らない種別・認証方式はnullにする", () => {
    const draft = normalizeDraft({ displayName: "家計", kind: "rails", auth: "saml" });
    expect(draft?.kind).toBeNull();
    expect(draft?.auth).toBeNull();
    expect(draft?.displayName).toBe("家計");
  });

  it("何も決まっていなければnull", () => {
    expect(normalizeDraft({})).toBeNull();
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft("家計レポート")).toBeNull();
  });
});

describe("parseConsultResponse", () => {
  it("素のJSONを読む", () => {
    const result = parseConsultResponse(
      '{"reply":"保存先はDBでよいですか。","ready":false,"draft":{"displayName":"家計レポート"}}',
    );
    expect(result.reply).toBe("保存先はDBでよいですか。");
    expect(result.ready).toBe(false);
    expect(result.draft?.displayName).toBe("家計レポート");
  });

  it("コードフェンスで囲まれていても読む", () => {
    const result = parseConsultResponse('```json\n{"reply":"はい","ready":true,"draft":null}\n```');
    expect(result.reply).toBe("はい");
    expect(result.ready).toBe(true);
    expect(result.draft).toBeNull();
  });

  it("返事が取れなければ失敗させる", () => {
    expect(() => parseConsultResponse('{"ready":true}')).toThrow();
    expect(() => parseConsultResponse("こんにちは")).toThrow();
  });

  it("readyはtrueのときだけtrue", () => {
    expect(parseConsultResponse('{"reply":"a","ready":"yes"}').ready).toBe(false);
  });
});
