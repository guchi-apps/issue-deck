/**
 * Supabase Authまわりの環境変数が「実際にログインできる値」になっているかの判定（#1419）。
 *
 * 判定を足した理由は、**未設定でもログインボタンが押せてしまい、画面が真っ白になる**ため。
 * `supabase.auth.signInWithOAuth()`は`NEXT_PUBLIC_SUPABASE_URL`をそのまま使って
 * `<URL>/auth/v1/authorize`へブラウザを飛ばすので、値がプレースホルダのままだと存在しない
 * ホストへ遷移して何も表示されない（#1419で遭遇。原因に辿り着くまでURLを読むしかなかった）。
 *
 * DBアクセスなしの純粋関数として置き、サーバーコンポーネントから呼ぶ。
 */

/**
 * CIワークフローがビルドを通すためだけに入れているダミー値の目印。
 * `.github/workflows/ci.yml`・`claude-*.yml`・`scripts/capture-issue-screenshots.sh`が
 * `https://ci-placeholder.supabase.co` / `ci-placeholder` を渡しており、**同じ値がサブPCの
 * `.env.local`にも入っていた**（#1419の原因）。値を変えるときは上記もあわせて変える。
 */
export const CI_PLACEHOLDER_MARKER = "ci-placeholder";

function isUsableValue(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !trimmed.includes(CI_PLACEHOLDER_MARKER);
}

/**
 * Supabase Authへ実際に飛ばせる設定になっているか。
 * URL・publishable keyのどちらかが空、またはCI用プレースホルダなら false。
 */
export function isSupabaseConfigured(): boolean {
  return (
    isUsableValue(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    isUsableValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  );
}

/**
 * ログインを許可するメールアドレスが1件以上設定されているか（サーバー専用）。
 *
 * ここが空だと、Supabaseの設定が正しくても`/auth/callback`の`isEmailAllowed()`が必ず偽になり、
 * `?error=not_allowed`でログイン画面へ戻ってくる。**Supabaseの値だけ直しても通らない**ため、
 * 詰まる場所を先に見せる目的で分けている。
 */
export function isAllowedEmailsConfigured(): boolean {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .some((email) => email.trim().length > 0);
}
