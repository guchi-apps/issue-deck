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
 * `.github/workflows/ci.yml`・`claude-*.yml`が
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
 * Supabase Management API（Redirect URLsの自動管理。#3568）を呼べる設定になっているか（サーバー専用）。
 * プロジェクトrefは`NEXT_PUBLIC_SUPABASE_URL`から抽出するため、そちらが未設定でもfalseになる。
 */
export function isSupabaseManagementApiConfigured(): boolean {
  return (
    isUsableValue(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    isUsableValue(process.env.SUPABASE_MANAGEMENT_API_TOKEN)
  );
}
