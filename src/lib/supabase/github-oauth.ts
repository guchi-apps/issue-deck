import { createClient } from "@/lib/supabase/client";

/**
 * GitHub連携のOAuthフローを開始する。ログイン画面の初回ログインだけでなく、
 * アクセストークン失効時の再ログイン導線からも呼び出される共通処理。
 * 既にGitHubにログイン済みであれば再認可の同意画面は出ずそのまま`nextPath`へ戻る。
 */
export async function startGithubOAuth(nextPath: string) {
  const supabase = createClient();

  await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
      scopes: "repo user:email",
    },
  });
}
