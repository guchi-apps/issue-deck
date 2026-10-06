import { Suspense } from "react";
import { FlaskConical, LayoutDashboard, TriangleAlert } from "lucide-react";

import { GithubLoginButton } from "@/components/auth/github-login-button";
import { LoginBfcacheReload } from "@/components/auth/login-bfcache-reload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isDevLoginEnabled } from "@/lib/dev-login";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // 設定が足りない環境（サブPCのworktreeの開発サーバー等）では、押しても存在しないURLへ
  // 飛ぶだけで画面が真っ白になる（#1419）。押せなくしたうえで詰まっている場所を出す。
  const supabaseConfigured = isSupabaseConfigured();

  // 開発環境にはデータが無いのが既定の状態で、Supabaseの設定が揃っていても画面は空になる（#1473）。
  // ダミーデータを投入してある場合だけ、その入口をここに出す。サーバー側で判定するため
  // 本番のHTMLには一切出ない。
  const devLoginEnabled = isDevLoginEnabled();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <LoginBfcacheReload />
      <div className="flex items-center gap-2 text-xl font-semibold">
        <LayoutDashboard className="size-6 text-primary" />
        IssueDeck
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ログイン</CardTitle>
          <CardDescription>
            GitHubアカウントでログインして、複数リポジトリのIssueを横断管理しましょう。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error === "not_allowed" && (
            <p className="text-sm text-destructive">このアカウントではログインできません。</p>
          )}
          {error === "callback_failed" && (
            <p className="text-sm text-destructive" role="alert">
              ログインの完了処理に失敗しました。もう一度GitHubでログインしてください。
              繰り返す場合は管理者にお問い合わせください。
            </p>
          )}
          {!supabaseConfigured && (
            <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3 text-sm ring-1 ring-foreground/10">
              <p className="flex items-center gap-2 font-medium">
                <TriangleAlert className="size-4 shrink-0 text-destructive" />
                この環境ではログインできません
              </p>
              {!supabaseConfigured && (
                <p className="text-muted-foreground">
                  Supabaseの接続先が未設定です（CI用のプレースホルダのままの場合も含む）。
                  <code>.env.local</code>の<code>NEXT_PUBLIC_SUPABASE_URL</code>と
                  <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>
                  を設定して、開発サーバーを起こし直してください。
                </p>
              )}
            </div>
          )}
          <Suspense fallback={null}>
            <GithubLoginButton disabled={!supabaseConfigured} />
          </Suspense>
          {devLoginEnabled && (
            <form action="/api/dev/login" method="post" className="flex flex-col gap-2">
              <div className="border-t pt-3">
                <Button type="submit" variant="outline" className="w-full">
                  <FlaskConical className="size-4" />
                  開発用ダミーユーザーでログイン
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                <code>pnpm db:seed:dev</code>
                で投入したダミーデータを見るための開発専用の入口です。実際のGitHubのIssueは表示されません。
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
