import Link from "next/link";
import { LogIn, LayoutDashboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
          {/* GitHub App連携によるログインはM2で実装。M1ではモック遷移のみ */}
          <Button asChild className="w-full">
            <Link href="/dashboard">
              <LogIn />
              GitHubで始める
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
