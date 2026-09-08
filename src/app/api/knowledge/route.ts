import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { fetchKnowledgeFiles, fetchKnowledgeMemos } from "@/lib/github/knowledge-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import {
  buildCandidate,
  parseKnowledgeFile,
  sortCandidates,
  sortKnowledgeSections,
  type KnowledgeBoardData,
} from "@/lib/knowledge-board";

/**
 * 「共通知識」画面（#2912）のデータ。
 *
 * `guchi-apps/docs`の`knowledge/`と、フリート各リポジトリの知見メモを1つにまとめて返す。
 * **読み取りだけ**で、判定も書き込みも行わない。
 *
 * **取得結果をプロセス内で数分持ち回る。** 材料が変わるのは共有知識へのPRがマージされたときと、
 * 格上げ判定（毎日05:00 JST）が走ったときだけで、どちらも日単位でしか動かない。一方で取得には
 * GraphQLを最大4回・実測16秒かかるため、開き直すたびに待たせないだけの短い保持で十分効く。
 * `?refresh=1`を付けると捨てて取り直す（判定を手で流した直後に確かめられるように）。
 *
 * キャッシュはユーザーを跨がない。中身はprivateリポジトリのファイルとIssueなので、鍵に
 * ユーザーIDを含める（`release-history`のように毎回取り直す形にしなかったのは所要時間のため）。
 */

const CACHE_MS = 5 * 60_000;

const cache = new Map<string, { at: number; data: KnowledgeBoardData }>();

export function GET(request: NextRequest) {
  return withGithubApiFeature("knowledge_board", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  const cached = cache.get(user.id);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.data);
  }

  const result = await withUserGithubToken(user, "GET /api/knowledge", async (token) => {
    // 共有知識のファイルと知見メモは互いに依存しないので同時に投げる。
    const [{ files, docsRepoUrl }, { issues, truncated }] = await Promise.all([
      fetchKnowledgeFiles(token),
      fetchKnowledgeMemos(token),
    ]);

    const sections = sortKnowledgeSections(files.flatMap(parseKnowledgeFile));
    const candidates = sortCandidates(
      issues.map(buildCandidate).filter((c): c is NonNullable<typeof c> => c !== null),
    );

    const data: KnowledgeBoardData = {
      sections,
      fileCount: files.length,
      candidates,
      truncated,
      docsRepoUrl,
    };
    return data;
  });

  if ("errorResponse" in result) {
    return result.errorResponse;
  }

  cache.set(user.id, { at: Date.now(), data: result.value });
  return NextResponse.json(result.value);
}
