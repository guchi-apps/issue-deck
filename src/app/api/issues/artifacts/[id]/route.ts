import { NextResponse, type NextRequest } from "next/server";

import { ARTIFACT_CONTENT_SECURITY_POLICY, buildArtifactDocument } from "@/lib/artifact-document";
import { requireUserId } from "@/lib/auth-user";
import { readSessionArtifactHtml } from "@/lib/dispatch/session-artifacts";

/**
 * アーティファクトの実物をHTMLとして配る（#2154）。**画面のiframeが直接開く先。**
 *
 * claude.aiのページは`frame-ancestors 'self'`でiframeに入らないので、ここが
 * 「ブラウザに遷移せずにアプリ上で表示する」の実体になる。
 *
 * **中身はエージェントが書いた任意のHTML・JS。** issue-deckと同じオリジンから素直に出すと、
 * そのJSからissue-deckのCookieやlocalStorageへ手が届くため、`sandbox`指定のCSPで
 * 不透明なオリジンへ落とす（画面側のiframeにも`sandbox`属性を付ける。二重に掛けるのは、
 * URLを直接開かれた場合にも効かせるため）。
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) {
    // iframeの中に出るので、JSONではなく人が読める文言を返す
    return htmlResponse("<p>ログインが必要です。</p>", 401);
  }

  const { id } = await params;
  const artifact = await readSessionArtifactHtml(id);
  if (!artifact) {
    return htmlResponse("<p>このアーティファクトは見つかりませんでした。</p>", 404);
  }

  return htmlResponse(buildArtifactDocument({ html: artifact.html, title: artifact.title }), 200);
}

function htmlResponse(html: string, status: number) {
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": ARTIFACT_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      // 同じURLへ再公開すると中身が入れ替わる（保存ファイル名は変わるが、`<id>`は変わらない）
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
