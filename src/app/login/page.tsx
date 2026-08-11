import { Suspense } from "react";
import { LayoutDashboard } from "lucide-react";

import { GithubLoginButton } from "@/components/auth/github-login-button";
import { LoginBfcacheReload } from "@/components/auth/login-bfcache-reload";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

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
          <Suspense fallback={null}>
            <GithubLoginButton />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
