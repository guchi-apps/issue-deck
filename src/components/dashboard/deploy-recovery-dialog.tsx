"use client";

import { useState } from "react";
import { GitPullRequestArrow, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  fetchDeployRecoveryCandidates,
  requestDeployRecovery,
  type DeployRecoveryCandidate,
} from "@/lib/deploy-recovery";

type DeployRecoveryDialogProps = {
  repositoryFullName: string;
  block?: boolean;
};

/** 失敗した本番へ、選択したdevelop済みPRだけを運ぶ復旧用PRを作る。 */
export function DeployRecoveryDialog({ repositoryFullName, block = false }: DeployRecoveryDialogProps) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<DeployRecoveryCandidate[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  async function handleOpen() {
    setOpen(true);
    setCandidates(null);
    setSelected([]);
    setError(null);
    setCreatedUrl(null);
    setLoading(true);
    try {
      setCandidates(await fetchDeployRecoveryCandidates(repositoryFullName));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  function toggle(number: number) {
    setSelected((current) =>
      current.includes(number) ? current.filter((value) => value !== number) : [...current, number],
    );
  }

  async function createRecoveryPullRequest() {
    if (selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await requestDeployRecovery(repositoryFullName, selected);
      setCreatedUrl(result.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={block ? "h-8 w-full justify-center gap-1" : "h-6 gap-1 px-2 text-xs"}
        onClick={() => void handleOpen()}
      >
        <GitPullRequestArrow className="size-3" aria-hidden="true" />
        修正PRを選んで復旧
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>修正PRだけを本番へ反映しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              mainを起点に選択したPRだけを取り込む復旧用PRを作成します。未選択のdevelop変更は含めません。
              作成後はGitHub上で内容を確認してmainへマージしてください。マージするとdeploy.ymlが起動します。
            </AlertDialogDescription>
          </AlertDialogHeader>

          {loading && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              main未反映のマージ済みPRを確認しています…
            </p>
          )}

          {candidates !== null && candidates.length === 0 && (
            <p className="text-xs text-muted-foreground">
              mainへ取り込めるマージ済みPRがありません。修正をdevelopへマージしてから、もう一度開いてください。
            </p>
          )}

          {candidates !== null && candidates.length > 0 && !createdUrl && (
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border p-1">
              <p className="px-2 py-1 text-xs text-muted-foreground">
                取り込むPRを選択してください。表示順に取り込みます。
              </p>
              {candidates.map((candidate) => (
                <label
                  key={candidate.number}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-accent"
                >
                  <Checkbox
                    checked={selected.includes(candidate.number)}
                    onCheckedChange={() => toggle(candidate.number)}
                    aria-label={`#${candidate.number} ${candidate.title}を取り込む`}
                  />
                  <span className="min-w-0 text-xs leading-relaxed">
                    <span className="font-medium">#{candidate.number}</span> {candidate.title}
                  </span>
                </label>
              ))}
            </div>
          )}

          {createdUrl && (
            <p className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs leading-relaxed">
              復旧用PRを作成しました。内容を確認してmainへマージしてください。{" "}
              <a href={createdUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                復旧用PRを開く
              </a>
            </p>
          )}

          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>{createdUrl ? "閉じる" : "キャンセル"}</AlertDialogCancel>
            {!createdUrl && (
              <AlertDialogAction
                disabled={loading || candidates === null || selected.length === 0 || submitting}
                onClick={(event) => {
                  event.preventDefault();
                  void createRecoveryPullRequest();
                }}
              >
                {submitting ? "復旧用PRを作成中…" : `${selected.length}件で復旧用PRを作成`}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
