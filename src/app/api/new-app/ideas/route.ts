import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { fetchIdeaDoc, listIdeaDocs } from "@/lib/github/ideas-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { isIdeaDocPath, parseIdeaDoc } from "@/lib/new-app/idea-doc";

/**
 * 構想メモ（`guchi-apps/ideas`）をウィザードへ渡す（#2432）。
 *
 * - `GET /api/new-app/ideas` … 構想メモの一覧
 * - `GET /api/new-app/ideas?path=ideas/<候補名>/README.md` … 1件を読んで仕様案へ解析する
 *
 * **何も作らない。** 読み取りだけなので、押す前に何度でも呼べる。
 *
 * **リポジトリを読めなくても200で返す**（`available: false`）。構想の置き場はprivateで、
 * 権限が無い環境もありうる。ここを失敗にすると、構想を使わない立ち上げまで巻き込んで
 * 画面にエラーが出る。
 */

export function GET(request: NextRequest) {
  return withGithubApiFeature("new_app_launch", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const path = request.nextUrl.searchParams.get("path");
  if (path !== null && !isIdeaDocPath(path)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await withUserGithubToken(user, "GET /api/new-app/ideas", async (token) => {
    if (path === null) {
      const ideas = await listIdeaDocs(token);
      return ideas === null ? { available: false, ideas: [] } : { available: true, ideas };
    }

    const doc = await fetchIdeaDoc(token, path);
    if (doc === null) return { available: false, idea: null };
    return { available: true, idea: { path: doc.path, ...parseIdeaDoc(doc.markdown) } };
  });

  if ("errorResponse" in result) {
    return result.errorResponse;
  }
  return NextResponse.json(result.value);
}
