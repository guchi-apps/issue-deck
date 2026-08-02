import { Progress } from "@/components/ui/progress";
import type { InstallationRateLimit } from "@/hooks/use-github-rate-limit";

type GithubRateLimitListProps = {
  data: InstallationRateLimit[] | null;
  isLoading: boolean;
  error: string | null;
};

export function GithubRateLimitList({ data, isLoading, error }: GithubRateLimitListProps) {
  return (
    <>
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">連携中のインストールがありません</p>
      )}
      {data && data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.map((rateLimit) => (
            <li key={rateLimit.accountLogin} className="rounded-lg border p-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium">{rateLimit.accountLogin}</span>
                <span className="text-muted-foreground">
                  残り {rateLimit.remaining} / {rateLimit.limit}
                </span>
              </div>
              <Progress value={(rateLimit.remaining / rateLimit.limit) * 100} />
              <p className="mt-1 text-xs text-muted-foreground">
                リセット: {new Date(rateLimit.reset * 1000).toLocaleTimeString("ja-JP")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
