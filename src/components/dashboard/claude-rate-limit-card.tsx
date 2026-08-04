import { Progress } from "@/components/ui/progress";
import type { ClaudeRateLimit } from "@/hooks/use-claude-rate-limit";

type ClaudeRateLimitCardProps = {
  data: ClaudeRateLimit | null;
  isLoading: boolean;
  error: string | null;
  notConfigured: boolean;
};

export function ClaudeRateLimitCard({
  data,
  isLoading,
  error,
  notConfigured,
}: ClaudeRateLimitCardProps) {
  return (
    <>
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notConfigured && (
        <p className="text-xs text-muted-foreground">Claude APIキーが設定されていません</p>
      )}
      {data && (
        <div className="rounded-lg border p-2">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="font-medium">トークン</span>
            <span className="text-muted-foreground">
              残り {data.remaining} / {data.limit}
            </span>
          </div>
          <Progress value={(data.remaining / data.limit) * 100} />
          <p className="mt-1 text-xs text-muted-foreground">
            リセット: {new Date(data.reset * 1000).toLocaleTimeString("ja-JP")}
          </p>
        </div>
      )}
    </>
  );
}
