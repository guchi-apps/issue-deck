"use client";

import { FilePlus2, Loader2, ScanSearch } from "lucide-react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Button } from "@/components/ui/button";
import {
  CODE_REVIEW_SEVERITIES,
  countCodeReviewFindings,
  describeCodeReviewSeverity,
  type CodeReviewFinding,
  type CodeReviewReport,
  type CodeReviewSeverity,
} from "@/lib/github/code-review";
import { cn } from "@/lib/utils";

/**
 * レビューIssueの詳細に出す、コードレビューの結果（#698）。
 *
 * **1指摘＝1カード**にして、重要度・種別・ファイル:行を本文より先に読めるようにする。
 * 結果はコメントとしても残っている（`MarkdownBody`でそのまま出る）が、長い1件のコメントを
 * 上から読むと「どれが重いのか」「どこの話か」が見えない。ここはその見出しだけを取り出す場所。
 *
 * **カードの「Issueを作成」は起票しない。** 埋めた新規作成ダイアログを開くだけで、実際に
 * 立てるかどうかは指摘を読んだ人が決める（実機設定の切り出し・#2021と同じ立場）。
 * エージェントに起票までさせないのは、指摘の質がレビューごとにばらつくため——数十件の
 * Issueが自動で立つと、盤面の方が壊れる。
 *
 * **書式を読めなかった結果は隠さない。** 指摘が1件も取れなかった場合は総評だけを出し、
 * 詳細はコメント欄で読んでもらう（パネルを作れないことを理由に、投稿された結果そのものを
 * 画面から消さない）。
 */
export function CodeReviewPanel({
  report,
  isPending,
  createdFindingIssues,
  onCreateFindingIssue,
  className,
}: {
  /** いちばん新しいレビュー結果。まだ返っていなければ`null` */
  report: CodeReviewReport | null;
  /** 依頼したがまだ結果が返っていない（`isCodeReviewPending`） */
  isPending: boolean;
  /**
   * 既にIssueにした指摘（見出し → Issue番号）。**同じ指摘を2回起票するのを防ぐためのもの。**
   *
   * 判定は**同じリポジトリに同じタイトルのIssueがあるか**だけで、正はGitHub側のIssue。
   * 取れなければ空でよい（ボタンが出続けるだけ）。レビューを回し直すと同じ指摘が返るので、
   * ここが無いと同じIssueが何件も立つ。
   */
  createdFindingIssues?: ReadonlyMap<string, number>;
  /** 指摘をIssueにする。渡さない画面ではボタンを出さない */
  onCreateFindingIssue?: (finding: CodeReviewFinding) => void;
  className?: string;
}) {
  if (!report && !isPending) return null;

  const findings = report?.findings ?? [];
  const counts = countCodeReviewFindings(findings);

  return (
    <section className={cn("rounded-lg border", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold">
          <ScanSearch className="size-3.5 text-muted-foreground" />
          レビュー結果
        </h3>
        {report ? (
          findings.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {CODE_REVIEW_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => (
                <SeverityBadge key={severity} severity={severity} count={counts[severity]} />
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">指摘なし</span>
          )
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            レビュー中
          </span>
        )}
      </div>

      {/* いつ時点の何を読んだのか（#1583と同じ考え方）。これが無いと、指摘を読んだ人は
          自分の手元のコードと突き合わせようがない */}
      {report?.basis && (
        <p className="border-b px-3 py-1.5 font-mono text-[11px] break-all text-muted-foreground">
          読んだコード: {report.basis}
        </p>
      )}

      {report && report.summary.trim() !== "" && (
        <MarkdownBody content={report.summary} className="px-3 py-2 text-xs leading-relaxed" />
      )}

      {!report && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          サブPCのセッションがリポジトリ全体を読んでいます。結果はこのIssueのコメントとして返ります。
        </p>
      )}

      {findings.length > 0 && (
        <ul className="flex flex-col">
          {findings.map((finding, index) => (
            <li
              key={`${finding.severity}-${index}-${finding.title}`}
              className="flex flex-col gap-1.5 border-t px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityBadge severity={finding.severity} />
                {finding.category && (
                  <span className="rounded-full border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {finding.category}
                  </span>
                )}
                {finding.location && (
                  <span className="min-w-0 font-mono text-[11px] break-all text-muted-foreground">
                    {finding.location}
                  </span>
                )}
              </div>

              <p className="text-xs leading-relaxed font-semibold">{finding.title}</p>

              {finding.body.trim() !== "" && (
                <MarkdownBody content={finding.body} className="text-xs leading-relaxed" />
              )}

              {onCreateFindingIssue && (
                <div className="flex flex-wrap items-center gap-2">
                  {createdFindingIssues?.has(finding.title) ? (
                    <span className="text-[11px] text-muted-foreground">
                      #{createdFindingIssues.get(finding.title)} として起票済み
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onCreateFindingIssue(finding)}
                    >
                      <FilePlus2 />
                      Issueを作成
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 重要度のバッジ。**重大はdestructive、中は`00.check-user`と同じamber、軽微はニュートラル**で、
 * 盤面で既に意味を持っている色から外れないようにする（`ManualStepPanel`が
 * amberを避けたのと同じ考え方の裏返しで、こちらは「人が見て判断するもの」なので同じ色に寄せる）。
 */
function SeverityBadge({ severity, count }: { severity: CodeReviewSeverity; count?: number }) {
  const tone: Record<CodeReviewSeverity, string> = {
    high: "border-destructive/30 bg-destructive/10 text-destructive",
    medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    low: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
        tone[severity],
      )}
    >
      {describeCodeReviewSeverity(severity)}
      {count !== undefined && ` ${count}`}
    </span>
  );
}
