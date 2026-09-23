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
import { mergeSuggestedLabels } from "@/components/dashboard/create-issue-dialog";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { describeClaudeModel, type ClaudeLocalModel } from "@/lib/app-settings";
import {
  buildCodeReviewFindingIssueDraft,
  resolveCodeReviewFindingLabels,
  type CodeReviewFinding,
} from "@/lib/github/code-review";
import { pickBulkReserveHost } from "@/lib/nightly-run";
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
  /** 予約先の候補（`dispatch.hosts`）。担当ホストが無ければ「予約する」は出さない（#3417） */
  hosts?: readonly { name: string; repositories: readonly string[] }[];
  /** 予約実行へ積んだあとの再取得（左メニュー・一覧の印を更新する） */
  onNightlyRunQueued?: () => void;
};

/** 予約実行で選べるモデル。「実装を開始」ダイアログのClaude Code側の候補と同じ */
const RESERVE_MODELS = ["fable", "opus", "sonnet"] as const satisfies readonly ClaudeLocalModel[];

/** 作成したIssueを「次の5時間枠」へ積む。積む口は「実装を開始」ダイアログと同じ`POST /api/nightly-run` */
async function reserveOnNextWindow(params: {
  repositoryFullName: string;
  number: number;
  host: string;
  model: ClaudeLocalModel | null;
}): Promise<string | null> {
  try {
    const res = await fetch("/api/nightly-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: params.repositoryFullName,
        issue: params.number,
        host: params.host,
        kind: "next-window",
        // 未選択（設定に従う）のときは送らない。積む口が「未指定＝設定の既定」として扱う
        ...(params.model ? { model: params.model } : {}),
      }),
    });
    if (res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    return json.message ?? `予約実行に積めませんでした (${res.status})`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * コードレビューの指摘から、選んだ分だけ直列でIssueを作成する確認ダイアログ（#2859）。
 *
 * **個別のタイトル・本文は編集できない。** 埋めた新規作成ダイアログ（`CreateIssueDialog`）を
 * 開くだけの1件ずつの「Issueを作成」とは違い、ここは選択した指摘を`buildCodeReviewFindingIssueDraft`
 * の下書きどおりにそのまま作成する。「どれを起票するか」を選ぶ判断はチェックボックスに残す
 * ——数十件が無条件で自動生成される事態を避ける考え方は変えていない（`code-review-panel.tsx`参照）。
 * 担当者は付けない。個別に直したい指摘があれば、従来どおり1件ずつの「Issueを作成」を使う。
 *
 * **ラベルは自動で付く（#3417。設定UIは無い）。** 種別は1件ずつの作成と同じ`/api/issues/suggest`で
 * 指摘ごとに判定し、優先度は重要度から決める（`resolveCodeReviewFindingLabels`）。
 * 「作成後に次の5時間枠へ予約する」をONにすると、作成できた分を`POST /api/nightly-run`へ積む。
 * 予約の失敗はIssueの作成を巻き戻さず、行に理由を出して「作成」の押し直しで積み直せる。
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
  hosts = [],
  onNightlyRunQueued,
}: BulkCreateCodeReviewIssuesDialogProps) {
  const { createIssue, isSubmitting: isCreating, error, setError } = useIssueMutations();
  const { labels: repoLabels, isLoading: isLoadingLabels } = useIssueRepoMeta(
    open && repositoryFullName ? repositoryFullName : null,
  );
  const { generate: suggestLabels } = useIssueSuggest();
  const reserveHost = pickBulkReserveHost(hosts, repositoryFullName);
  const [reserve, setReserve] = useState(false);
  const [model, setModel] = useState<ClaudeLocalModel | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const isSubmitting = isCreating || isRunning;
  const [reservedIndices, setReservedIndices] = useState<Set<number>>(new Set());
  const [reserveFailures, setReserveFailures] = useState<Map<number, string>>(new Map());
  const [createdIssues, setCreatedIssues] = useState<Map<number, Issue>>(new Map());
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
    setCreatedIssues(new Map());
    setReservedIndices(new Set());
    setReserveFailures(new Map());
    setReserve(false);
    setModel(null);
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

  /** 種別はAI判定、優先度は重要度から。ラベル無しでは作らない（#3417） */
  async function resolveLabels(finding: CodeReviewFinding, body: string): Promise<string[]> {
    const repoLabelNames = repoLabels.map((label) => label.name);
    const suggestion = await suggestLabels(
      body,
      repoLabels.map((label) => ({ name: label.name, description: label.description })),
    );
    // 判定に失敗しても作成は止めない。種別は既定へ倒れる
    const kinds = mergeSuggestedLabels([], suggestion?.labels ?? []);
    return resolveCodeReviewFindingLabels({
      severity: finding.severity,
      suggestedKindLabels: kinds,
      repoLabelNames,
    });
  }

  async function handleSubmit() {
    setError(null);
    const targets = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ index }) => selected.has(index) && isPending(index));
    if (targets.length === 0) return;

    setIsRunning(true);
    try {
      const failures = new Map(reserveFailures);
      for (const { finding, index } of targets) {
        let issue = createdIssues.get(index) ?? null;
        if (!issue) {
          const draft = buildCodeReviewFindingIssueDraft({ finding, repositoryFullName, reviewNumber });
          issue = await createIssue({
            repositoryFullName: draft.repositoryFullName,
            title: draft.title,
            body: draft.body,
            labels: await resolveLabels(finding, draft.body),
            assignee: null,
          });
          // 失敗した時点で止める。エラーはuseIssueMutations側のerrorに入っており、成功済みの
          // ものはonCreatedで既に反映されている
          if (!issue) return;
          const created = issue;
          setCreatedIndices((prev) => new Set(prev).add(index));
          setCreatedIssues((prev) => new Map(prev).set(index, created));
          onCreated(issue);
        }
        if (reserve && reserveHost) {
          const message = await reserveOnNextWindow({
            repositoryFullName,
            number: issue.number,
            host: reserveHost,
            model,
          });
          if (message === null) {
            failures.delete(index);
            setReservedIndices((prev) => new Set(prev).add(index));
            onNightlyRunQueued?.();
          } else {
            failures.set(index, message);
          }
        }
      }
      setReserveFailures(failures);
      // 予約に積めなかったものがあれば開いたままにし、理由を見せて押し直せるようにする
      if (failures.size === 0) onOpenChange(false);
    } finally {
      setIsRunning(false);
    }
  }

  /** まだやることが残っているか。作成前、または予約ONで積めていないもの */
  function isPending(index: number): boolean {
    if (!createdIndices.has(index)) return true;
    return reserve && reserveHost !== null && !reservedIndices.has(index);
  }

  const pendingCount = findings.filter((_, index) => selected.has(index) && isPending(index)).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>指摘をまとめてIssueにする</DialogTitle>
          <DialogDescription>
            選択した指摘ごとに、{repositoryFullName} へIssueを作成します。種別・優先度のラベルは
            自動で付きます。作成後にタイトル・本文を直したい場合は、作成されたIssueから編集してください。
          </DialogDescription>
        </DialogHeader>

        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {findings.map((finding, index) => {
            const created = createdIndices.has(index);
            const disabled = created || isSubmitting;
            const reserveFailure = reserveFailures.get(index);
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
                  {created && (
                    <span className="text-[11px] text-muted-foreground">
                      作成済み{reservedIndices.has(index) ? "・予約済み" : ""}
                    </span>
                  )}
                  {reserveFailure && (
                    <span className="text-[11px] text-destructive">予約できませんでした: {reserveFailure}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {reserveHost && (
          <div className="flex flex-col gap-2 rounded-md border p-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={reserve}
                disabled={isSubmitting}
                onCheckedChange={(checked) => setReserve(checked === true)}
              />
              作成後に「次の5時間枠」へ予約する
            </label>
            {reserve && (
              <div role="radiogroup" aria-label="使用モデル" className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="mr-0.5 text-muted-foreground">使用モデル（{pendingCount}件すべてに適用）</span>
                {[null, ...RESERVE_MODELS].map((value) => (
                  <button
                    key={value ?? "default"}
                    type="button"
                    role="radio"
                    aria-checked={model === value}
                    disabled={isSubmitting}
                    onClick={() => setModel(value)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs",
                      model === value
                        ? "border-indigo-500 bg-indigo-50 font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    {value ? describeClaudeModel(value) : "設定に従う"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <ApiErrorMessage message={error} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || isLoadingLabels || pendingCount === 0}>
            {isSubmitting
              ? "作成中..."
              : reserve && reserveHost
                ? `${pendingCount}件を作成して予約`
                : `${pendingCount}件のIssueを作成`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
