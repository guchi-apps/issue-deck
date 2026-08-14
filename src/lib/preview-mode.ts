import { NextResponse } from "next/server";

/**
 * 本番データに触れうる環境でアプリを動かすときのガード。元はFly.ioのプレビュー環境
 * （本番DBをコピーして動かす）向けに入れたもので、そのプレビューは#1308で廃止したが、
 * ガード自体は`PREVIEW_MODE`が未設定なら何もしない安全側の作りで、サブPC上の開発環境
 * （#1265）など今後の同種の用途にも効くため残している。
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
