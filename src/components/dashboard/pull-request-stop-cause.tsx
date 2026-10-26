import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { InlineReasonText } from "@/components/dashboard/merge-check-reason-notice";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import type { PullRequestStopCause, StopCauseLink, UnidentifiedStopCause } from "@/lib/pull-request-stop-cause";
import { cn } from "@/lib/utils";

const UNIDENTIFIED_WHY: Record<UnidentifiedStopCause["why"], string> = {
  "no-record": "`00.check-user`が付いた前後に、原因として読める記録がありません。",
  multiple: "付与の前後に原因の記録が複数あり、どれが直接の原因か決められません。",
  "fetch-failed": "対応Issueの記録を取得できませんでした。",
};

function Time({ iso }: { iso: string | null }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={formatDateTimeFull(iso)} className="tabular-nums">
      {formatDateTime(iso)}
    </time>
  );
}

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-[11px] whitespace-nowrap text-muted-foreground max-sm:mt-1.5">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/**
 * 対応Issueの`00.check-user`で自動マージが止まったときの直接原因（#5080）。自動マージの見込みの帯の直下に置く。
 *
 * 原因・記録の出所と時刻・次の操作に加えて、阻止条件（`00.check-user`と付与時刻）と直近の判定を並べ、
 * **原因の時刻と判定の時刻を見比べられる**ようにする（古い原因を今のものと読ませない）。原因を決められない
 * ときは「直接原因を確認できません」と理由・調べる場所だけを出し、推測で埋めない。
 */
export function PullRequestStopCauseNotice({
  stopCause,
  repositoryFullName,
  className,
}: {
  stopCause: PullRequestStopCause;
  repositoryFullName: string;
  className?: string;
}) {
  const { cause, judgement } = stopCause;
  const identified = cause.status === "identified";
  const issueLink = (children: ReactNode) => (
    <GithubReferenceLink
      href={stopCause.issueUrl}
      reference={{ repositoryFullName, number: stopCause.issueNumber, kind: "issue" }}
      className="text-primary hover:underline"
    >
      {children}
    </GithubReferenceLink>
  );
  const investigate: StopCauseLink[] = cause.status === "unidentified" ? cause.investigate : [];

  return (
    <div
      data-testid="merge-stop-cause"
      data-status={cause.status}
      className={cn(
        "overflow-hidden rounded-md border bg-card text-xs leading-relaxed",
        identified ? "border-amber-500/40" : "border-dashed",
        className,
      )}
    >
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b px-3 py-2">
        <span className="text-[11px] tracking-wider text-muted-foreground">止まった原因</span>
        <span className="min-w-0 flex-1 basis-60 font-semibold">
          {identified ? <InlineReasonText text={cause.title} /> : "直接原因を確認できません"}
        </span>
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2 max-sm:grid-cols-1 max-sm:gap-y-0.5">
        {identified ? (
          <>
            <Row term="記録">
              <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>
                  Issue #{stopCause.issueNumber}の<InlineReasonText text={cause.sourceLabel} />
                </span>
                <Time iso={cause.sourceAt} />
                {cause.sourceUrl && <OutLink href={cause.sourceUrl}>記録を開く</OutLink>}
              </span>
            </Row>
            <Row term="次の操作">
              <ol className="list-decimal pl-4">
                {cause.actions.map((action) => (
                  <li key={action}>
                    <InlineReasonText text={action} />
                  </li>
                ))}
              </ol>
              {cause.stallPanel && (
                <p className="mt-1">{issueLink("Issue詳細の停滞パネルを開く")}</p>
              )}
            </Row>
          </>
        ) : (
          <>
            <Row term="理由">
              <InlineReasonText text={UNIDENTIFIED_WHY[cause.why]} />
            </Row>
            <Row term="調べる場所">
              <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
                {investigate.map((link) => (
                  <OutLink key={link.url} href={link.url}>
                    {link.label}
                  </OutLink>
                ))}
                {issueLink(`Issue #${stopCause.issueNumber}`)}
                {judgement?.url && <OutLink href={judgement.url}>判定ログ</OutLink>}
              </span>
            </Row>
          </>
        )}
        <Row term="阻止条件">
          対応Issue {issueLink(`#${stopCause.issueNumber}`)}の<InlineReasonText text="`00.check-user`" />
          {stopCause.labeledAt && (
            <>
              （<Time iso={stopCause.labeledAt} />に付与）
            </>
          )}
          。
          <span className="text-[11px] text-muted-foreground">
            レビュー・CIの成功とは別の条件で、このラベルが外れるまで自動マージされません。
          </span>
        </Row>
        <Row term="直近の判定">
          {judgement ? (
            <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
              {judgement.completedAt ? (
                <span>
                  <Time iso={judgement.completedAt} /> 完了・自動マージは予約されず
                </span>
              ) : (
                <span>完了・自動マージは予約されず</span>
              )}
              {judgement.url && <OutLink href={judgement.url}>判定ログ</OutLink>}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">自動マージの判定の記録が見つかりません</span>
          )}
        </Row>
      </dl>
    </div>
  );
}
