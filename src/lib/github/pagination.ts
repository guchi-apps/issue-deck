import { GithubApiError } from "@/lib/github/github-api-error";
import { githubFetch } from "@/lib/github/request";

function getNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    if (relPart === 'rel="next"') {
      return urlPart.slice(1, -1);
    }
  }
  return null;
}

/**
 * ページ数の上限を決めて取る（#2475）。
 *
 * `fetchAllPages`と違い、**1回の呼び出しで使うレート制限の量を呼び出し側が決められる**。
 * 「リポジトリの全コメント」のように初回だけ極端に多いものを、巡回のたびに少しずつ
 * 進めるために使う。続きが残っているかは`hasMore`で返し、どこから再開するかは
 * 呼び出し側がカーソルとして持つ（Linkヘッダの`next`は次の巡回まで持ち越せない）。
 */
export async function fetchPagesUpTo<T>(
  initialUrl: string,
  token: string,
  maxPages: number,
): Promise<{ items: T[]; hasMore: boolean }> {
  const results: T[] = [];
  let url: string | null = initialUrl;
  let pages = 0;

  while (url && pages < maxPages) {
    const res: Response = await githubFetch(url, token);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GithubApiError(
        res.status,
        `GitHub API request failed: ${res.status} ${url} ${detail}`,
      );
    }

    const page: T[] = await res.json();
    results.push(...page);
    pages += 1;
    url = getNextUrl(res.headers.get("link"));
  }

  return { items: results, hasMore: url !== null };
}

export async function fetchAllPages<T>(
  initialUrl: string,
  token: string,
): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = initialUrl;

  while (url) {
    // ページごとに1リクエストとして計測されるため、コメント全件取得のような
    // 多ページの取得も使用量の内訳にそのまま反映される。
    const res: Response = await githubFetch(url, token);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
    }

    const page: T[] = await res.json();
    results.push(...page);
    url = getNextUrl(res.headers.get("link"));
  }

  return results;
}
