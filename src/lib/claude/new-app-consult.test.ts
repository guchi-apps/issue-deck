import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSULT_OPENING_MESSAGE,
  CONSULT_RESPONSE_SCHEMA,
  MAX_CONSULT_TURNS,
  buildConsultMessages,
  continueNewAppConsult,
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
  });

  it("JSONでない地の文は返事として扱い、会話を止めない（#2281）", () => {
    const result = parseConsultResponse("収益化を考えるとZennがよさそうですね。");
    expect(result.reply).toBe("収益化を考えるとZennがよさそうですね。");
    expect(result.draft).toBeNull();
    expect(result.ready).toBe(false);
  });

  it("途中で切れたJSONは地の文にせず失敗させる（#2281）", () => {
    expect(() => parseConsultResponse('{"reply":"保存先はDBでよいで')).toThrow();
  });

  it("readyはtrueのときだけtrue", () => {
    expect(parseConsultResponse('{"reply":"a","ready":"yes"}').ready).toBe(false);
  });
});

describe("CONSULT_RESPONSE_SCHEMA", () => {
  it("構造化出力の必須条件（required・additionalProperties: false）を満たす", () => {
    expect(CONSULT_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    expect(CONSULT_RESPONSE_SCHEMA.required).toEqual(["reply", "ready", "draft"]);

    const draft = CONSULT_RESPONSE_SCHEMA.properties.draft.anyOf[0];
    expect(draft.additionalProperties).toBe(false);
    // `draft`の項目とスキーマの項目がずれると、決めた値が設定ステップへ渡らない
    expect([...draft.required].sort()).toEqual(
      ["auth", "displayName", "kind", "repositoryName", "subdomain", "summary", "usesDatabase"],
    );
  });
});

describe("continueNewAppConsult", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockClaudeResponse(text: string, stopReason = "end_turn") {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: stopReason }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  function sentBody(fetchMock: ReturnType<typeof mockClaudeResponse>) {
    return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
  }

  it("応答の形をスキーマで縛って送る（#2281）", async () => {
    const fetchMock = mockClaudeResponse('{"reply":"はい","ready":false,"draft":null}');

    const result = await continueNewAppConsult("dummy-token", [
      { role: "user", content: "記事投稿ツールを作りたい" },
    ]);

    expect(result.reply).toBe("はい");
    expect(sentBody(fetchMock).output_config).toEqual({
      format: { type: "json_schema", schema: CONSULT_RESPONSE_SCHEMA },
    });
  });

  it("途中で切れた応答は、原因の分かる文言で失敗させる（#2281）", async () => {
    mockClaudeResponse('{"reply":"保存先は', "max_tokens");

    await expect(
      continueNewAppConsult("dummy-token", [{ role: "user", content: "作りたい" }]),
    ).rejects.toThrow(/途中で切れました/);
  });
});
