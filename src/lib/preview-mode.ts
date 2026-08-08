import { NextResponse } from "next/server";

/**
 * Fly.io Machines上のオンデマンドプレビュー環境（本番DBをコピーして動かす）向けのガード。
 * プレビュー環境から誤って本番のGitHubリポジトリへ書き込みが行われないよう、
 * `PREVIEW_MODE=true` のときは書き込み系API routeを403で封じる。
 */
export function isPreviewMode(): boolean {
  return process.env.PREVIEW_MODE === "true";
}

/**
 * 書き込み系API route（POST/PATCH/DELETEのエクスポート関数）の先頭で呼び出す。
 * `withGithubApiFeature`は計測のみを行う薄いラッパーで内部に403分岐を挟めないため、
 * その外側でこのガードを個別に呼ぶ。プレビュー環境では403のレスポンスを返し、
 * それ以外では null を返す（呼び出し側は null の場合のみ処理を続行する）。
 */
export function previewModeGuard(): NextResponse | null {
  if (!isPreviewMode()) return null;
  return NextResponse.json({ error: "preview_mode_forbidden" }, { status: 403 });
}
