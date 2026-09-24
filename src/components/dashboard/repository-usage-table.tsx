import { repositoryRankColor } from "@/components/dashboard/repository-pie-chart";
import {
  formatUsageUsd,
  REPOSITORY_PIE_MIN_FRACTION,
  type UsageGroup,
} from "@/lib/session-usage-view";

/**
 * AI使用量「リポジトリ別」の全件の表（#3423）。円グラフは金額が全体の3%以上のリポジトリと「その他」にまとめるため、
 * 「その他」に入ったリポジトリの金額はここで読む。並びは受け取った順（集計側が金額順に並べてある）。
 * 円グラフの切れと同じ色の点を、3%以上のリポジトリに付ける（未満は「その他」のグレー）。
 */
export function RepositoryUsageTable({ groups }: { groups: Pick<UsageGroup, "key" | "costUsd">[] }) {
  const total = groups.reduce((sum, group) => sum + group.costUsd, 0);
  return (
    <div
      id="repository-usage-table"
      tabIndex={0}
      className="max-h-64 overflow-auto rounded-md border text-xs"
    >
      <table className="w-full border-collapse tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="sticky top-0 bg-card px-2 py-1.5 text-left font-medium">リポジトリ</th>
            <th className="sticky top-0 bg-card px-2 py-1.5 text-right font-medium">割合</th>
            <th className="sticky top-0 bg-card px-2 py-1.5 text-right font-medium">金額</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, rank) => (
            <tr key={group.key} className="border-t">
              <td className="px-2 py-1">
                <span
                  aria-hidden
                  className="mr-1.5 inline-block size-2 rounded-full"
                  style={{
                    background:
                      total > 0 && group.costUsd / total >= REPOSITORY_PIE_MIN_FRACTION
                        ? repositoryRankColor(rank) : "var(--pie-other)",
                  }}
                />
                {group.key || "(不明)"}
              </td>
              <td className="px-2 py-1 text-right">
                {total > 0 ? `${((group.costUsd / total) * 100).toFixed(1)}%` : "-"}
              </td>
              <td className="px-2 py-1 text-right">{formatUsageUsd(group.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
