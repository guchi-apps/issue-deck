"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fetchRcImportOptions, requestRcImport, type RcImportOptionsResponse } from "@/lib/release-request";
import { cn } from "@/lib/utils";

/**
 * 新方式の候補へ、developへマージ済みの既存PRを選んで取り込む（#4986）。
 *
 * **選択は広げない。** 既定で選ぶのは何も無し。固定範囲外のPRは、行ごとの承認にチェックしたものだけ
 * `approveExtra`に含める。依存するPRが要るかどうかは自動判定せず、選んだPRより前に入った未選択のPRを示すだけで、
 * 当たらなければworkflowが必要なPRを示して止まる。head・マージコミット・範囲の検証はサーバーが取り直す。
 */
export function RcImportPanel({
  repositoryFullName,
  pullRequestNumber,
  onImported,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  onImported?: () => void;
}) {
  const [data, setData] = useState<RcImportOptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  // 同じ選択の再送は同じ要求キーにする（二重送信でrevisionが2つ進まない）。選び直したら作り直す
  const requestKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchRcImportOptions(repositoryFullName, pullRequestNumber));
      setSelected(new Set());
      setApproved(new Set());
      requestKey.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repositoryFullName, pullRequestNumber]);

  useEffect(() => {
    let cancelled = false;
    fetchRcImportOptions(repositoryFullName, pullRequestNumber)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryFullName, pullRequestNumber]);

  function changeSelection(next: Set<number>, nextApproved: Set<number>) {
    requestKey.current = null;
    setSelected(next);
    setApproved(new Set([...nextApproved].filter((n) => next.has(n))));
  }

  if (loading && !data) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        取り込めるPRを確認しています…
      </p>
    );
  }
  if (!data) return error ? <p className="text-xs text-destructive">{error}</p> : null;

  const options = data.options;
  const chosen = options.filter((o) => selected.has(o.number));
  const needApproval = chosen.filter((o) => o.approvalRequired);
  const missingApproval = needApproval.filter((o) => !approved.has(o.number));
  // 選んだPRより番号が小さい（先にdevelopへ入った可能性が高い）未選択のPR。依存漏れの手がかり
  const maxChosen = chosen.reduce((m, o) => Math.max(m, o.number), 0);
  const possiblyNeeded = options.filter((o) => !selected.has(o.number) && o.problem === null && o.number < maxChosen);
  const canSubmit = !submitting && data.blocked === null && chosen.length > 0 && missingApproval.length === 0 && done === null;

  async function submit() {
    if (!data || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      requestKey.current ??= `ui-${crypto.randomUUID()}`;
      const result = await requestRcImport(repositoryFullName, {
        candidateId: data.candidateId,
        expectedHeadSha: data.headSha,
        selected: chosen.map((o) => ({ number: o.number, expectedMergeSha: o.mergeSha })),
        approveExtra: needApproval.map((o) => o.number),
        requestKey: requestKey.current,
      });
      setDone(result.revision);
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 border-t pt-2 text-xs" data-testid="release-rc-import">
      <p className="font-medium">既存のPRを選んで候補へ取り込む</p>
      <p className="text-muted-foreground">
        候補の先端 <code>{data.headSha.slice(0, 7)}</code>（revision {data.revision}）の後にdevelopへ入ったPRを、選んだものだけ足します。
        取り込むと新しいrevisionになり、統合検証と全体レビューがやり直されます（旧結果では公開できません）。
      </p>
      {data.blocked && <p className="text-amber-700 dark:text-amber-400">{data.blocked}</p>}
      {options.length === 0 ? (
        <p className="text-muted-foreground">取り込めるPRはありません。修正をdevelopへマージしてから開き直してください。</p>
      ) : (
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border" aria-label="候補へ取り込めるPR">
          {options.map((o) => {
            const selectable = o.problem === null && data.blocked === null;
            const id = `rc-import-${o.number}`;
            return (
              <li key={o.number} className={cn("flex min-w-0 items-start gap-2 p-2", !selectable && "opacity-70")}>
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={selected.has(o.number)}
                  disabled={submitting || done !== null || !selectable}
                  onCheckedChange={(value) => {
                    const next = new Set(selected);
                    if (value === true) next.add(o.number);
                    else next.delete(o.number);
                    changeSelection(next, approved);
                  }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <label htmlFor={id} className="break-words font-medium">
                    #{o.number} {o.title}
                  </label>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                    {o.issueNumber !== null && <span>Issue #{o.issueNumber}</span>}
                    {o.relatedFix ? (
                      <span className="rounded bg-purple-500/10 px-1 text-purple-700 dark:text-purple-300">この候補の修正</span>
                    ) : o.approved ? (
                      <span>承認済みの範囲外PR</span>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">範囲外（取り込むには承認が必要）</span>
                    )}
                    <span>{o.merged ? "developへマージ済み" : "developへ未マージ"}</span>
                    {o.mergeSha && <code>merge {o.mergeSha.slice(0, 7)}</code>}
                    <GithubReferenceLink href={o.url} className="hover:underline">
                      PRを開く
                    </GithubReferenceLink>
                  </p>
                  {o.problemLabel && <p className="text-amber-700 dark:text-amber-400">{o.problemLabel}</p>}
                  {selected.has(o.number) && o.approvalRequired && (
                    <label className="mt-0.5 flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                      <Checkbox
                        checked={approved.has(o.number)}
                        disabled={submitting || done !== null}
                        onCheckedChange={(value) => {
                          const next = new Set(approved);
                          if (value === true) next.add(o.number);
                          else next.delete(o.number);
                          setApproved(next);
                          requestKey.current = null;
                        }}
                      />
                      この候補に含める範囲外のPRとして承認する
                    </label>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p>
        <span className="font-medium">追加される範囲:</span> {chosen.length === 0 ? "（未選択）" : chosen.map((o) => `#${o.number}`).join("、")}
        <span className="text-muted-foreground"> — 選んでいないPRは自動では足しません。</span>
      </p>
      {possiblyNeeded.length > 0 && (
        <p className="text-amber-700 dark:text-amber-400" data-testid="release-rc-import-deps">
          選んだPRより先にdevelopへ入った未選択のPRがあります（{possiblyNeeded.map((o) => `#${o.number}`).join("、")}）。選んだPRがこれらに依存している場合、
          競合して止まり、必要なPRが示されます。必要なら追加で選んでください。
        </p>
      )}
      {missingApproval.length > 0 && (
        <p className="text-amber-700 dark:text-amber-400">承認が必要なPR（{missingApproval.map((o) => `#${o.number}`).join("、")}）の承認にチェックしてください。</p>
      )}
      {done !== null && (
        <p className="text-emerald-700 dark:text-emerald-400">
          取り込みを依頼しました（revision {done}）。これは合格ではありません。新しい先端で統合検証と全体レビューが走ります。
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? "取り込みを依頼中…" : `選んだ${chosen.length}件を取り込む`}
        </Button>
        {error && (
          <Button size="sm" variant="outline" disabled={submitting} onClick={() => void load()}>
            一覧を読み込み直す
          </Button>
        )}
      </div>
    </div>
  );
}
