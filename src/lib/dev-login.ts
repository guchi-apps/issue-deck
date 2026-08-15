/**
 * ローカル開発でSupabase Authを経由せずログイン済み状態に入るための判定（#1473）。
 *
 * 仕組みそのものは`src/lib/ci-auth-bypass.ts`のCIバイパス（Cookie）をそのまま使う。
 * CIではPlaywrightが直接Cookieを差すので導線が要らなかったが、ローカルでは人が手で
 * Cookieを差すことになり実質使えなかった。ここではログイン画面にボタンを出すかどうかの
 * 判定だけを持ち、Cookie名・ユーザーIDは既存の定数を使い回す（値を二重に持たない）。
 *
 * DBアクセスなしの純粋関数として置き、サーバーコンポーネントとRoute Handlerから呼ぶ。
 */

/**
 * 開発用ログインを有効にしてよい環境か。
 *
 * 本番（`NODE_ENV=production`）では常に偽。`isCiBypassRequest`側も同じ条件で無効化するため
 * 二重に塞がっている（片方だけ緩めない）。シークレットは`pnpm db:seed:dev`が生成する。
 */
export function isDevLoginEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (process.env.CI_LOGIN_BYPASS_SECRET ?? "").length > 0;
}
