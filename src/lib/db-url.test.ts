import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
  resolveDatabaseUrl,
} from "@/lib/db-url";

const BASE_URL = "mysql://issue_deck:devpassword@127.0.0.1:3306/app_issue_deck_dev";

describe("resolveDatabaseUrl", () => {
  it("プール設定が無いURLへ既定のconnection_limit・pool_timeoutを補う", () => {
    const resolved = new URL(resolveDatabaseUrl(BASE_URL)!);

    expect(resolved.searchParams.get("connection_limit")).toBe(String(DEFAULT_CONNECTION_LIMIT));
    expect(resolved.searchParams.get("pool_timeout")).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS));
    // 接続先の情報は変えない
    expect(resolved.protocol).toBe("mysql:");
    expect(resolved.host).toBe("127.0.0.1:3306");
    expect(resolved.pathname).toBe("/app_issue_deck_dev");
    expect(resolved.username).toBe("issue_deck");
    expect(resolved.password).toBe("devpassword");
  });

  it("URLに書かれた指定を環境変数・既定値より優先する", () => {
    const resolved = new URL(
      resolveDatabaseUrl(`${BASE_URL}?connection_limit=42&pool_timeout=1`, {
        connectionLimit: "7",
        poolTimeout: "7",
      })!,
    );

    expect(resolved.searchParams.get("connection_limit")).toBe("42");
    expect(resolved.searchParams.get("pool_timeout")).toBe("1");
  });

  it("環境変数での上書きを既定値より優先する", () => {
    const resolved = new URL(
      resolveDatabaseUrl(BASE_URL, { connectionLimit: "3", poolTimeout: "0" })!,
    );

    expect(resolved.searchParams.get("connection_limit")).toBe("3");
    // pool_timeout=0（待ち時間無制限）は有効な指定として扱う
    expect(resolved.searchParams.get("pool_timeout")).toBe("0");
  });

  it("数値として解釈できない上書きは無視して既定値を使う", () => {
    for (const connectionLimit of ["", " ", "abc", "-1", "1.5", "0"]) {
      const resolved = new URL(resolveDatabaseUrl(BASE_URL, { connectionLimit })!);
      expect(resolved.searchParams.get("connection_limit")).toBe(String(DEFAULT_CONNECTION_LIMIT));
    }

    const resolved = new URL(resolveDatabaseUrl(BASE_URL, { poolTimeout: "-1" })!);
    expect(resolved.searchParams.get("pool_timeout")).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS));
  });

  it("URLとして解釈できない値・未設定はそのまま返す", () => {
    expect(resolveDatabaseUrl("not a url")).toBe("not a url");
    expect(resolveDatabaseUrl("")).toBe("");
    expect(resolveDatabaseUrl(undefined)).toBeUndefined();
  });
});
