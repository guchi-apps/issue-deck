import Link from "next/link";
import { Clock } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function GithubSetupPendingPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Clock className="size-8 text-muted-foreground" />
          <CardTitle>組織の管理者の承認待ちです</CardTitle>
          <CardDescription>
            インストール申請を送信しました。組織の管理者が承認すると、選択したリポジトリのIssueを閲覧できるようになります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/dashboard">ダッシュボードに戻る</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
