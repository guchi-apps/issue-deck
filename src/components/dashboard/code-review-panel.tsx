"use client";

import { FilePlus2, ListChecks, Loader2, RotateCw, ScanSearch } from "lucide-react";

import { CodeReviewSeverityBadge } from "@/components/dashboard/code-review-result-badges";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Button } from "@/components/ui/button";
import {
  CODE_REVIEW_SEVERITIES,
  countCodeReviewFindings,
  filterUncreatedCodeReviewFindings,
  type CodeReviewFinding,
  type CodeReviewReport,
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
 *
 * **「まとめてIssueを作成」は選んだ分だけ直接起票する（#2859）。** 1件ずつの「Issueを作成」
 * とは違い、確認ダイアログ（`BulkCreateCodeReviewIssuesDialog`）を経由してタイトル・本文を
 * そのまま作成する。人の判断を消しているわけではなく、**「どれを起票するか選ぶ」判断は
 * チェックボックスの選択に残す**——数十件が無条件で自動生成される事態は変わらず避けている。
 * 個別のタイトル・本文を直したい場合は従来どおり1件ずつの「Issueを作成」を使う。
 */
export function CodeReviewPanel({
  report,
  isPending,
  createdFindingIssues,
  onCreateFindingIssue,
  onBulkCreateFindingIssues,
  onRestartReview,
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
  /**
   * 未起票の指摘をまとめて選び、一括でIssueにする確認ダイアログを開く（#2859）。
   * 渡さない画面ではボタンを出さない。渡す指摘は呼び出し側ではなくここで
   * `filterUncreatedCodeReviewFindings`により絞り込む（一覧に出ている件数とボタンが
   * 起票する候補件数をずらさないため）。
   */
  onBulkCreateFindingIssues?: (findings: CodeReviewFinding[]) => void;
  /**
   * 同じリポジトリをもう一度レビューする（実行ダイアログを開く）。
   *
   * **結果を読んだ場所から起こし直せるようにする。** 直したあとに効いたかを見たくなるのは
   * 結果を読んだ直後で、そのたびに「コードレビュー」ビューへ戻るのは遠い。
   * 走っている最中（`isPending`）は出さない。
   */
  onRestartReview?: () => void;
  className?: string;
}) {
  if (!report && !isPending) return null;

  const findings = report?.findings ?? [];
  const counts = countCodeReviewFindings(findings);
  const uncreatedFindings = filterUncreatedCodeReviewFindings(findings, createdFindingIssues);

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
                <CodeReviewSeverityBadge
                  key={severity}
                  severity={severity}
                  count={counts[severity]}
                />
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
        {report && (onBulkCreateFindingIssues || onRestartReview) && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {onBulkCreateFindingIssues && uncreatedFindings.length > 0 && (
              <Button
                size="xs"
                onClick={() => onBulkCreateFindingIssues(uncreatedFindings)}
              >
                <ListChecks />
                まとめてIssueを作成 ({uncreatedFindings.length}件)
              </Button>
            )}
            {onRestartReview && (
              <Button size="xs" variant="outline" onClick={onRestartReview}>
                <RotateCw />
                もう一度レビュー
              </Button>
            )}
          </div>
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
                <CodeReviewSeverityBadge severity={finding.severity} />
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
