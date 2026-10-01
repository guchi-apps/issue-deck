import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  detectExtensions,
  IOS_EXTENSION_REPOSITORY_NAMES,
  isExtensionCandidatePath,
  type IosExtension,
} from "@/lib/ios-extensions";

/**
 * iOS拡張（ウィジェット等）の一覧（#3708）。対象は`IOS_EXTENSION_REPOSITORY_NAMES`の固定リストだけ。
 * リポジトリのデフォルトブランチのツリーから拡張らしいSwiftファイルを選び、宣言から種類を推定する。
 * 結果は5分キャッシュする（`?refresh=1`で取り直す）。
 */
const CACHE_TTL_MS = 5 * 60_000;
const MAX_FILES = 40;

type RepositoryResult = {
  fullName: string;
  htmlUrl: string;
  extensions: IosExtension[];
  scannedFiles: number;
  /** ツリーが大きすぎる・候補が多すぎて、走査を打ち切ったか */
  truncated: boolean;
  error: string | null;
};

const cache = new Map<string, { at: number; value: RepositoryResult }>();

export function GET(request: NextRequest) {
  return withGithubApiFeature("ios_extensions", () => handleGET(request));
}

async function getJson<T>(url: string, token: string): Promise<T | null> {
  const res = await githubFetch(url, token);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function scanRepository(
  token: string,
  fullName: string,
  defaultBranch: string,
): Promise<Pick<RepositoryResult, "extensions" | "scannedFiles" | "truncated" | "error">> {
  const base = `${GITHUB_API}/repos/${fullName}`;
  const tree = await getJson<{ truncated?: boolean; tree: { path: string; type: string; sha: string }[] }>(
    `${base}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token,
  );
  if (!tree) return { extensions: [], scannedFiles: 0, truncated: false, error: "ツリーを取得できませんでした" };

  const candidates = tree.tree.filter((entry) => entry.type === "blob" && isExtensionCandidatePath(entry.path));
  const selected = candidates.slice(0, MAX_FILES);
  const files = await Promise.all(
    selected.map(async (entry) => {
      const blob = await getJson<{ content: string; encoding: string }>(`${base}/git/blobs/${entry.sha}`, token);
      if (!blob || blob.encoding !== "base64") return null;
      return { path: entry.path, source: Buffer.from(blob.content, "base64").toString("utf8") };
    }),
  );

  return {
    extensions: detectExtensions(files.filter((file): file is { path: string; source: string } => file !== null)),
    scannedFiles: selected.length,
    truncated: Boolean(tree.truncated) || candidates.length > MAX_FILES,
    error: null,
  };
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";

  const repositories = await db.repository.findMany({
    where: {
      fullName: { in: [...IOS_EXTENSION_REPOSITORY_NAMES] },
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
    orderBy: { fullName: "asc" },
  });

  // リネーム前後の名前（kurashio／myroom）が同じリポジトリを指すことがあるため、GitHub上のidで重複を除く
  const unique = [...new Map(repositories.map((repository) => [repository.githubRepositoryId, repository])).values()];

  const results = await Promise.all(
    unique.map(async (repository): Promise<RepositoryResult> => {
      const cached = cache.get(repository.fullName);
      if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

      let value: RepositoryResult;
      try {
        const token = await getInstallationToken(repository.installation.installationId);
        const scanned = await scanRepository(token, repository.fullName, repository.defaultBranch);
        value = { fullName: repository.fullName, htmlUrl: repository.htmlUrl, ...scanned };
      } catch (error) {
        console.error(`[GET /api/repositories/ios-extensions] ${repository.fullName}:`, error);
        value = {
          fullName: repository.fullName,
          htmlUrl: repository.htmlUrl,
          extensions: [],
          scannedFiles: 0,
          truncated: false,
          error: "拡張を取得できませんでした",
        };
      }
      // 失敗は保持しない（次の表示で取り直す）
      if (value.error === null) cache.set(repository.fullName, { at: Date.now(), value });
      return value;
    }),
  );

  return NextResponse.json({ repositories: results });
}
