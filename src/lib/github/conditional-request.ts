import { recordGithubApiCall } from "@/lib/github/api-usage";
import { githubFetch } from "@/lib/github/request";

/**
 * ETagによる条件付きGET（#1531）。
 *
 * GitHubのREST APIは`If-None-Match`付きのリクエストが`304 Not Modified`を返したとき、
 * **その分をレート制限に計上しない**。PR一覧のように「対象リポジトリ数ぶんのリクエストを
 * 短い間隔で繰り返す」経路では、変化が無い間の消費をこれで実質ゼロにできる。
 * 「完了したPR」ビューの10秒ポーリング（`hooks/use-pull-requests.ts`）が成立しているのは
 * この仕組みのため——素で回すと26リポジトリ×360回/時でインストール当たりの上限
 * （5,000回/時）を超える。
 *
 * キャッシュはプロセス内メモリのLRUで、DBもスキーマも持たない（`api-usage.ts`と同じく
 * 単一プロセスでのデプロイ前提）。再起動で消えても次の1回が`200`になるだけで、
 * **キャッシュの古さが表示に出ることはない**——毎回GitHubへ問い合わせており、本文を
 * キャッシュから返すのはGitHub自身が「変わっていない」と答えたときに限られる。
 *
 * キーはURLだけでトークンを含めない。**権限の無いリポジトリに対しては304ではなく404が返る**
 * ため、別のインストールの内容がキャッシュ経由で漏れることはない。
 */

type CacheEntry = { etag: string; body: unknown };

/**
 * キャッシュの上限件数。check-runsのURLはhead SHAごとに増えるため、放っておくと
 * 際限なく溜まる。PR一覧1巡ぶん（リポジトリ数×2 + open PR数）を何十回ぶんか保持できれば
 * 足りるので、余裕を見てこの値にする。
 */
const MAX_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();

/** テスト用。プロセス内キャッシュを空にする */
export function clearConditionalRequestCache(): void {
  cache.clear();
}

export type ConditionalJsonResult<T> =
  | { ok: true; data: T; notModified: boolean }
  | { ok: false; status: number; detail: string };

/**
 * ETagキャッシュを使ってJSONを取得する。
 *
 * 失敗を例外にしないのは、呼び出し側で扱いが分かれるため（PR一覧は`GithubApiError`を投げ、
 * CI状態は`unknown`へ縮退させる）。ネットワーク自体の失敗は`githubFetch`が投げる例外のまま
 * 通す（再試行は`githubFetch`が持つ）。
 *
 * **返した本文はキャッシュと同じ実体なので、呼び出し側で書き換えない。** 次の304で同じものを
 * そのまま返すため、書き換えると以降のリクエストに残る。
 */
export async function githubFetchJsonWithEtag<T>(
  url: string,
  token: string,
): Promise<ConditionalJsonResult<T>> {
  const cached = cache.get(url);
  // 計上は応答を見てから行う（304はレート制限を消費しないため、使用量の内訳にも載せない）。
  const res = await githubFetch(url, token, {
    record: false,
    headers: cached ? { "If-None-Match": cached.etag } : undefined,
  });

  if (res.status === 304 && cached) {
    // 参照したエントリを新しい側へ寄せる（LRU）。
    cache.delete(url);
    cache.set(url, cached);
    return { ok: true, data: cached.body as T, notModified: true };
  }

  recordGithubApiCall(url);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail };
  }

  const data = (await res.json()) as T;
  const etag = res.headers.get("etag");
  if (etag) store(url, { etag, body: data });
  return { ok: true, data, notModified: false };
}

function store(url: string, entry: CacheEntry): void {
  // 上書きのときも一度消して入れ直し、挿入順＝参照の新しい順を保つ。
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
