import { Suspense } from "react";
import { LayoutDashboard } from "lucide-react";

import { GithubLoginButton } from "@/components/auth/github-login-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";

export default function LoginPage() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-muted/30 p-4">
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
        <CardContent>
          <Suspense fallback={null}>
            <GithubLoginButton />
          </Suspense>
        </CardContent>
      </Card>

      <div className="flex gap-4 text-xs text-muted-foreground">
        <a href={TERMS_OF_SERVICE_URL} target="_blank" rel="noopener noreferrer" className="hover:underline">
          利用規約
        </a>
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="hover:underline">
          プライバシーポリシー
        </a>
      </div>
    </div>
  );
}
