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
    const res: Response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API request failed: ${res.status} ${url}`);
    }

    const page: T[] = await res.json();
    results.push(...page);
    url = getNextUrl(res.headers.get("link"));
  }

  return results;
}
