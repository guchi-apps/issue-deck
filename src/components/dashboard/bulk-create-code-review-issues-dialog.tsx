"use client";

import { useEffect, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { CodeReviewSeverityBadge } from "@/components/dashboard/code-review-result-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { buildCodeReviewFindingIssueDraft, type CodeReviewFinding } from "@/lib/github/code-review";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

type BulkCreateCodeReviewIssuesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 未起票の指摘（呼び出し側で絞り込み済み。`CodeReviewPanel`の`filterUncreatedCodeReviewFindings`） */
  findings: CodeReviewFinding[];
  /** 起票先＝レビュー対象のリポジトリ */
  repositoryFullName: string;
  /** 起点になったレビューIssue番号 */
  reviewNumber: number;
  /** 作成したIssueを一覧へ反映する（`handleIssueCreated`と同じもの） */
  onCreated: (issue: Issue) => void;
};

/**
 * コードレビューの指摘から、選んだ分だけ直列でIssueを作成する確認ダイアログ（#2859）。
 *
 * **個別のタイトル・本文は編集できない。** 埋めた新規作成ダイアログ（`CreateIssueDialog`）を
 * 開くだけの1件ずつの「Issueを作成」とは違い、ここは選択した指摘を`buildCodeReviewFindingIssueDraft`
 * の下書きどおりにそのまま作成する。「どれを起票するか」を選ぶ判断はチェックボックスに残す
 * ——数十件が無条件で自動生成される事態を避ける考え方は変えていない（`code-review-panel.tsx`参照）。
 * ラベル・担当者は付けない。個別に直したい指摘があれば、従来どおり1件ずつの「Issueを作成」を使う。
 *
 * **直列実行し、途中で失敗したら残りを止める。** 成功した分はその都度`onCreated`で反映済みなので、
 * 失敗してダイアログを開いたままにしても成功分がロールバックされることはない。失敗した指摘と
 * それ以降は「作成」を押し直せば再試行できる（作成済みの指摘はチェックボックスごと固定される）。
 */
export function BulkCreateCodeReviewIssuesDialog({
  open,
  onOpenChange,
  findings,
  repositoryFullName,
  reviewNumber,
  onCreated,
}: BulkCreateCodeReviewIssuesDialogProps) {
  const { createIssue, isSubmitting, error, setError } = useIssueMutations();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [createdIndices, setCreatedIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    // 軽微は既定で外す。重大・中を優先して選ばせるための初期値で、選び直せば軽微も含められる
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(
      new Set(findings.map((_, index) => index).filter((index) => findings[index].severity !== "low")),
    );
    setCreatedIndices(new Set());
    setError(null);
    // findingsは呼び出し側で毎レンダー新しい配列参照になり得るため、依存配列には含めず
    // open変化時のみ初期化する（move-issue-dialog.tsxと同じ考え方）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setError]);

  function toggle(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleSubmit() {
    setError(null);
    const targets = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ index }) => selected.has(index) && !createdIndices.has(index));
    if (targets.length === 0) return;

    for (const { finding, index } of targets) {
      const draft = buildCodeReviewFindingIssueDraft({ finding, repositoryFullName, reviewNumber });
      const issue = await createIssue({
        repositoryFullName: draft.repositoryFullName,
        title: draft.title,
        body: draft.body,
        labels: [],
        assignee: null,
      });
      // 失敗した時点で止める。エラーはuseIssueMutations側のerrorに入っており、成功済みの
      // ものはonCreatedで既に反映されている
      if (!issue) return;
      setCreatedIndices((prev) => new Set(prev).add(index));
      onCreated(issue);
    }
    onOpenChange(false);
  }

  const pendingCount = findings.filter(
    (_, index) => selected.has(index) && !createdIndices.has(index),
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>指摘をまとめてIssueにする</DialogTitle>
          <DialogDescription>
            選択した指摘ごとに、{repositoryFullName} へIssueを作成します。作成後にタイトル・本文を
            直したい場合は、作成されたIssueから編集してください。
          </DialogDescription>
        </DialogHeader>

        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {findings.map((finding, index) => {
            const created = createdIndices.has(index);
            const disabled = created || isSubmitting;
            return (
              <li
                key={`${finding.title}-${index}`}
                // 行のどこを押しても切り替わるようにする（repository-visibility-section.tsxと
                // 同じ考え方）。チェックボックス自身のクリックはそこで止め、二重に切り替わらないようにする
                onClick={() => {
                  if (!disabled) toggle(index);
                }}
                className={cn(
                  "flex items-start gap-2 border-b py-2 last:border-b-0",
                  !disabled && "cursor-pointer",
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={created || selected.has(index)}
                  disabled={disabled}
                  onClick={(event) => event.stopPropagation()}
                  onCheckedChange={() => toggle(index)}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <CodeReviewSeverityBadge severity={finding.severity} />
                    {finding.location && (
                      <span className="min-w-0 font-mono text-[11px] break-all text-muted-foreground">
                        {finding.location}
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed font-medium">{finding.title}</p>
                  {created && <span className="text-[11px] text-muted-foreground">作成済み</span>}
                </div>
              </li>
            );
          })}
        </ul>

        <ApiErrorMessage message={error} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || pendingCount === 0}>
            {isSubmitting ? "作成中..." : `${pendingCount}件のIssueを作成`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
