import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import type { IosPrecheckPhase, IosPrecheckSummary } from "@/lib/github/ios-precheck";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<IosPrecheckPhase | "not_run", string> = {
  success: "成功",
  failure: "検証失敗",
  running: "検証中",
  waiting: "検証待ち",
  not_run: "未実施",
};

const PHASE_CLASS: Record<IosPrecheckPhase | "not_run", string> = {
  success: "bg-emerald-500/15 text-emerald-600 ring-emerald-500 dark:text-emerald-400",
  failure: "bg-red-500/15 text-red-600 ring-red-500 dark:text-red-400",
  running: "bg-sky-500/15 text-sky-600 ring-sky-500 dark:text-sky-400",
  waiting: "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400",
  not_run: "bg-muted text-muted-foreground ring-border",
};

function ShortSha({ sha, pullRequestUrl }: { sha: string; pullRequestUrl: string }) {
  return (
    <GithubReferenceLink href={`${pullRequestUrl}/commits/${sha}`} className="font-mono hover:underline">
      {sha.slice(0, 7)}
    </GithubReferenceLink>
  );
}

/**
 * Issue詳細の対応PRに、iOS事前検証（`issue-deck/ios-precheck`）の結果と検証したSHAを出す行（#4140）。
 *
 * **CIのバッジには混ぜず、専用の行にする。** 検証待ち（Macへ届かない・環境不足）は成功にも失敗にも
 * しない設計で、その理由（commit statusのdescription）まで読めないと次に何をすればよいかが
 * 分からないため、バッジ1つでは足りない。
 *
 * statusはSHAに付くので、**PRのheadに結果が無ければ「未実施」**と出し、前回の結果は検証したSHAと
 * 並べて参考として添える（古いSHAの成功を最新の成功に見せない）。
 */
export function IosPrecheckStatusLine({
  summary,
  pullRequestUrl,
  className,
}: {
  summary: IosPrecheckSummary;
  pullRequestUrl: string;
  className?: string;
}) {
  const phase = summary.head?.phase ?? "not_run";
  const result = summary.head ?? summary.previous;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1 text-xs", className)} data-testid="ios-precheck-status">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex w-fit items-center rounded-full px-2.5 py-1 font-medium ring-1 ring-inset",
            PHASE_CLASS[phase],
          )}
        >
          iOS事前検証: {PHASE_LABEL[phase]}
        </span>
        {summary.head ? (
          <span className="text-muted-foreground">
            検証SHA <ShortSha sha={summary.head.sha} pullRequestUrl={pullRequestUrl} />（PRの最新）
          </span>
        ) : (
          <span className="text-muted-foreground">
            PRの最新 <ShortSha sha={summary.headSha} pullRequestUrl={pullRequestUrl} /> は未検証
            {summary.previous && (
              <>
                {" "}
                ・前回 <ShortSha sha={summary.previous.sha} pullRequestUrl={pullRequestUrl} /> は
                {PHASE_LABEL[summary.previous.phase]}
              </>
            )}
          </span>
        )}
      </div>
      {result?.description && (
        <p className="break-words text-muted-foreground">
          {summary.head ? "" : "前回: "}
          {result.description}
        </p>
      )}
    </div>
  );
}
