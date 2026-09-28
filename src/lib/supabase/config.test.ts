import { afterEach, describe, expect, it } from "vitest";

import {
  isAllowedEmailsConfigured,
  isSupabaseConfigured,
  isSupabaseManagementApiConfigured,
} from "@/lib/supabase/config";

const ORIGINAL = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  allowedEmails: process.env.ALLOWED_EMAILS,
  managementApiToken: process.env.SUPABASE_MANAGEMENT_API_TOKEN,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore("NEXT_PUBLIC_SUPABASE_URL", ORIGINAL.url);
  restore("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ORIGINAL.key);
  restore("ALLOWED_EMAILS", ORIGINAL.allowedEmails);
  restore("SUPABASE_MANAGEMENT_API_TOKEN", ORIGINAL.managementApiToken);
});

describe("isSupabaseConfigured", () => {
  it("URLとpublishable keyが揃っていればtrue", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xxx";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("どちらかが未設定・空文字ならfalse", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xxx";
    expect(isSupabaseConfigured()).toBe(false);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "   ";
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("CI用プレースホルダのままならfalse（#1419の状態）", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ci-placeholder.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "ci-placeholder";
    expect(isSupabaseConfigured()).toBe(false);

    // 片方だけプレースホルダでも通さない
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xxx";
    expect(isSupabaseConfigured()).toBe(false);
  });
});

describe("isSupabaseManagementApiConfigured", () => {
  it("URLとPATが揃っていればtrue", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_MANAGEMENT_API_TOKEN = "sbp_dummy";
    expect(isSupabaseManagementApiConfigured()).toBe(true);
  });

  it("どちらかが未設定・空文字ならfalse", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_MANAGEMENT_API_TOKEN = "sbp_dummy";
    expect(isSupabaseManagementApiConfigured()).toBe(false);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_MANAGEMENT_API_TOKEN = "   ";
    expect(isSupabaseManagementApiConfigured()).toBe(false);
  });
});

describe("isAllowedEmailsConfigured", () => {
  it("1件でも設定されていればtrue", () => {
    process.env.ALLOWED_EMAILS = "me@example.com";
    expect(isAllowedEmailsConfigured()).toBe(true);

    process.env.ALLOWED_EMAILS = " , me@example.com ,";
    expect(isAllowedEmailsConfigured()).toBe(true);
  });

  it("未設定・空・カンマだけならfalse", () => {
    delete process.env.ALLOWED_EMAILS;
    expect(isAllowedEmailsConfigured()).toBe(false);

    process.env.ALLOWED_EMAILS = "";
    expect(isAllowedEmailsConfigured()).toBe(false);

    process.env.ALLOWED_EMAILS = " , ";
    expect(isAllowedEmailsConfigured()).toBe(false);
  });
});
