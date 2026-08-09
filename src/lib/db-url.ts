/**
 * PrismaへDATABASE_URLを渡す前に、コネクションプールの上限を明示する。
 *
 * Prismaは`connection_limit`が未指定だと「物理CPUコア数 × 2 + 1」をプールサイズとして採る。
 * この値はサーバーのコア数に引きずられて増え、同じMySQLサーバーを他アプリと共有している場合は
 * `max_connections`（ERROR 1040: Too many connections）を圧迫する。アプリ側が確保する上限を
 * コアの数と切り離して固定するため、URLへ明示的にクエリパラメータを載せる。
 *
 * 優先順位は「DATABASE_URLに書かれた値 > 環境変数での上書き > ここの既定値」。
 * DATABASE_URLに既に書かれている場合は一切触らないため、運用側で自由に上書きできる。
 */

/** `connection_limit`未指定時に適用するプールサイズ。単一プロセス・少人数利用の想定で小さく採る。 */
export const DEFAULT_CONNECTION_LIMIT = 5;

/**
 * `pool_timeout`未指定時に適用するプール待ちのタイムアウト（秒）。Prismaの既定は10秒。
 * プールを絞るぶん待ちが発生しやすくなるため、既定より長めに採る。
 */
export const DEFAULT_POOL_TIMEOUT_SECONDS = 20;

export type ConnectionPoolOverrides = {
  /** `DATABASE_CONNECTION_LIMIT`。数値として解釈できない値は無視して既定値を使う。 */
  connectionLimit?: string;
  /** `DATABASE_POOL_TIMEOUT`（秒）。0を指定するとPrisma側で待ち時間無制限になる。 */
  poolTimeout?: string;
};

/** 非負整数として解釈できる場合のみ数値を返す。それ以外（空文字・小数・負値など）はundefined。 */
function parseNonNegativeInt(value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed >= min ? parsed : undefined;
}

function applyDefaultParam(
  url: URL,
  name: string,
  override: string | undefined,
  fallback: number,
  min: number,
): void {
  // URLに書かれている指定を最優先する（運用側で明示した値を上書きしない）
  if (url.searchParams.has(name)) return;
  url.searchParams.set(name, String(parseNonNegativeInt(override, min) ?? fallback));
}

/**
 * DATABASE_URLへ`connection_limit`・`pool_timeout`の既定値を補う。
 *
 * 解釈できないURLはそのまま返す。プール設定の付与に失敗したせいでアプリが起動しなくなるより、
 * 従来どおりの接続を試みてPrisma側のエラーに委ねるほうが影響が小さいため。
 */
export function resolveDatabaseUrl(
  rawUrl: string | undefined,
  overrides: ConnectionPoolOverrides = {},
): string | undefined {
  if (!rawUrl) return rawUrl;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  applyDefaultParam(url, "connection_limit", overrides.connectionLimit, DEFAULT_CONNECTION_LIMIT, 1);
  applyDefaultParam(url, "pool_timeout", overrides.poolTimeout, DEFAULT_POOL_TIMEOUT_SECONDS, 0);

  return url.toString();
}
