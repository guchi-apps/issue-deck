import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addRedirectUrl,
  listRedirectUrls,
  parseRedirectUrlInput,
  removeRedirectUrl,
  replaceRedirectUrl,
  SupabaseManagementApiError,
} from "@/lib/supabase/management-api";

const ORIGINAL = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  token: process.env.SUPABASE_MANAGEMENT_API_TOKEN,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_MANAGEMENT_API_TOKEN = "sbp_dummy";
});

afterEach(() => {
  restore("NEXT_PUBLIC_SUPABASE_URL", ORIGINAL.url);
  restore("SUPABASE_MANAGEMENT_API_TOKEN", ORIGINAL.token);
  vi.unstubAllGlobals();
});

/** GETは常にcurrentを返し、PATCHは呼ばれた本文を記録する簡易スタブ */
function stubFetch(current: string) {
  const patchBodies: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.supabase.com/v1/projects/example/config/auth");
    if (!init || init.method === "GET" || init.method === undefined) {
      return new Response(JSON.stringify({ uri_allow_list: current }), { status: 200 });
    }
    if (init.method === "PATCH") {
      patchBodies.push(String(init.body));
      const body = JSON.parse(String(init.body)) as { uri_allow_list: string };
      current = body.uri_allow_list;
      return new Response(JSON.stringify({ uri_allow_list: current }), { status: 200 });
    }
    throw new Error(`unexpected method: ${init.method}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, patchBodies };
}

describe("parseRedirectUrlInput", () => {
  it("http(s)://で始まる文字列を受け付ける", () => {
    expect(parseRedirectUrlInput("https://example.gucchii.com/auth/callback")).toBe(
      "https://example.gucchii.com/auth/callback",
    );
    expect(parseRedirectUrlInput("  http://localhost:3000/auth/callback  ")).toBe(
      "http://localhost:3000/auth/callback",
    );
  });

  it("http(s)以外・空・文字列以外はnull", () => {
    expect(parseRedirectUrlInput("ftp://example.com")).toBeNull();
    expect(parseRedirectUrlInput("")).toBeNull();
    expect(parseRedirectUrlInput("   ")).toBeNull();
    expect(parseRedirectUrlInput(123)).toBeNull();
    expect(parseRedirectUrlInput(undefined)).toBeNull();
  });

  it("カンマを含む値はnull（uri_allow_listがカンマ区切りのため複数URLに分裂してしまう）", () => {
    expect(
      parseRedirectUrlInput("https://a.example.com/cb,https://b.example.com/cb"),
    ).toBeNull();
    expect(parseRedirectUrlInput("https://example.com/cb,")).toBeNull();
  });
});

describe("listRedirectUrls", () => {
  it("カンマ区切りの文字列を配列へ分解する", async () => {
    stubFetch("https://a.example.com/cb,https://b.example.com/cb");
    expect(await listRedirectUrls()).toEqual([
      "https://a.example.com/cb",
      "https://b.example.com/cb",
    ]);
  });

  it("空文字なら空配列", async () => {
    stubFetch("");
    expect(await listRedirectUrls()).toEqual([]);
  });
});

describe("addRedirectUrl", () => {
  it("末尾へ追加してPATCHする", async () => {
    const { patchBodies } = stubFetch("https://a.example.com/cb");
    const result = await addRedirectUrl("https://b.example.com/cb");
    expect(result).toEqual(["https://a.example.com/cb", "https://b.example.com/cb"]);
    expect(JSON.parse(patchBodies[0])).toEqual({
      uri_allow_list: "https://a.example.com/cb,https://b.example.com/cb",
    });
  });

  it("既に登録済みなら409相当のエラー", async () => {
    stubFetch("https://a.example.com/cb");
    await expect(addRedirectUrl("https://a.example.com/cb")).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("replaceRedirectUrl", () => {
  it("一致するURLだけを置き換える", async () => {
    const { patchBodies } = stubFetch("https://a.example.com/cb,https://b.example.com/cb");
    const result = await replaceRedirectUrl(
      "https://a.example.com/cb",
      "https://a2.example.com/cb",
    );
    expect(result).toEqual(["https://a2.example.com/cb", "https://b.example.com/cb"]);
    expect(JSON.parse(patchBodies[0]).uri_allow_list).toBe(
      "https://a2.example.com/cb,https://b.example.com/cb",
    );
  });

  it("対象が見つからなければ404相当のエラー（PATCHは呼ばない）", async () => {
    const { fetchMock } = stubFetch("https://a.example.com/cb");
    await expect(
      replaceRedirectUrl("https://missing.example.com/cb", "https://new.example.com/cb"),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // GETのみ
  });
});

describe("removeRedirectUrl", () => {
  it("一致するURLを取り除く", async () => {
    const { patchBodies } = stubFetch("https://a.example.com/cb,https://b.example.com/cb");
    const result = await removeRedirectUrl("https://a.example.com/cb");
    expect(result).toEqual(["https://b.example.com/cb"]);
    expect(JSON.parse(patchBodies[0]).uri_allow_list).toBe("https://b.example.com/cb");
  });

  it("対象が既に無ければ冪等に成功する（PATCHは呼ばない）", async () => {
    const { fetchMock } = stubFetch("https://a.example.com/cb");
    const result = await removeRedirectUrl("https://missing.example.com/cb");
    expect(result).toEqual(["https://a.example.com/cb"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // GETのみ
  });
});

describe("設定不足のとき", () => {
  it("NEXT_PUBLIC_SUPABASE_URLが不正な形式ならエラー", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-url";
    stubFetch("");
    await expect(listRedirectUrls()).rejects.toBeInstanceOf(SupabaseManagementApiError);
  });

  it("SUPABASE_MANAGEMENT_API_TOKENが未設定ならエラー", async () => {
    delete process.env.SUPABASE_MANAGEMENT_API_TOKEN;
    stubFetch("");
    await expect(listRedirectUrls()).rejects.toBeInstanceOf(SupabaseManagementApiError);
  });
});

describe("Management APIがエラーを返したとき", () => {
  it("ステータスを引き継ぎ、値は含めない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("token invalid", { status: 401 })),
    );
    await expect(listRedirectUrls()).rejects.toMatchObject({ status: 401 });
  });
});
