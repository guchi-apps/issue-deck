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
