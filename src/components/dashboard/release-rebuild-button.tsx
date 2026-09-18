"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { ReleaseBumpKindSelect } from "@/components/dashboard/release-bump-kind-select";
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
import { canRebuildRelease } from "@/lib/release-rebuild";
import {
  fetchReleaseRebuild,
  requestReleaseRebuild,
  type ReleaseRebuildInfo,
} from "@/lib/release-request";
import type { BumpKind } from "@/lib/semver-bump";
import { cn } from "@/lib/utils";

type ReleaseRebuildButtonProps = {
  repositoryFullName: string;
  /** 本番に出ている版（mainの版）。上げ幅の選択肢に目安を出すのに使う */
  mainVersion?: string | null;
  /** 作り直しを起動できたあと。親が状態を取り直す */
  onTriggered?: () => void;
  className?: string;
};

/**
 * 「修正を入れて作り直す」（#3014）。mainへのリリースPRが開いている間だけ置く。
 *
 * リリースPRは凍結ブランチ（`release-main/vX.Y.Z`）なので、出した後に見つかった修正はそこへ
 * 足せない。修正をdevelopへ入れてからこれを押すと、リリースPRを閉じてリリースworkflowを
 * 起動し直し、workflowが前回のバンプを取り消してバンプから作り直す。
 *
 * **材料（新たに入る変更）はダイアログを開いたときに取る。** PCの「ブランチ」画面は追加の
 * GitHub API取得をしない前提で組まれている（`RepositoryReleaseButton`と同じ）ため、
 * compareを常時叩かず、押した人にだけ1回払わせる。developに新しい変更が無ければ、
 * 作り直しても中身が変わらないので実行ボタンを押せなくする。
 */
export function ReleaseRebuildButton({
  repositoryFullName,
  mainVersion = null,
  onTriggered,
  className,
}: ReleaseRebuildButtonProps) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ReleaseRebuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bumpKind, setBumpKind] = useState<BumpKind | null>(null);

  async function handleOpen() {
    setOpen(true);
    setInfo(null);
    setError(null);
    setBumpKind(null);
    setLoading(true);
    try {
      setInfo(await fetchReleaseRebuild(repositoryFullName));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRebuild() {
    const pullRequest = info?.releasePullRequest;
    if (!pullRequest) return;
    setSubmitting(true);
    setError(null);
    try {
      await requestReleaseRebuild(repositoryFullName, pullRequest.number, bumpKind ?? undefined);
      setOpen(false);
      onTriggered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const pullRequest = info?.releasePullRequest ?? null;
  const candidate = info?.candidate ?? null;
  const rebuildable = pullRequest !== null && canRebuildRelease(candidate);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={cn(
          "h-6 shrink-0 gap-1 border-purple-500/60 px-2 text-xs text-purple-700 hover:bg-purple-500/10 dark:text-purple-300",
          className,
        )}
        onClick={() => void handleOpen()}
      >
        <RotateCcw className="size-3" />
        修正を入れて作り直す
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pullRequest ? `v${pullRequest.version} のリリースを作り直しますか？` : "リリースを作り直しますか？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              まだ本番へ出ていないリリースPRを閉じ、developの最新の内容でバージョンバンプからやり直します。
              修正は先にdevelopへマージしておいてください。
            </AlertDialogDescription>
          </AlertDialogHeader>

          {loading && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              リリースPRの後にdevelopへ入った変更を確認しています…
            </p>
          )}

          {info && !pullRequest && (
            <p className="text-xs text-muted-foreground">
              作り直せるリリースPR（release-main/v…）が開いていません。
            </p>
          )}

          {pullRequest && candidate && (
            <>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs">
                <li>
                  リリースPR{" "}
                  <GithubReferenceLink href={pullRequest.url} className="text-primary hover:underline">
                    #{pullRequest.number}
                  </GithubReferenceLink>{" "}
                  を閉じ、<code>release-main/v{pullRequest.version}</code> を削除します
                </li>
                <li>
                  v{pullRequest.version} のバンプを取り消し、上げ幅と更新履歴を判定し直します（v
                  {pullRequest.version} は欠番になり、次は v{pullRequest.version} より上の版になります）
                </li>
                <li>バンプPRがdevelopへ自動マージされると、新しいリリースPRが作られます</li>
              </ol>

              {rebuildable ? (
                <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    今回新たに含まれる変更
                    {candidate.pullRequests.length > 0
                      ? `（${candidate.pullRequests.length}件）`
                      : `（コミット ${candidate.aheadBy}件）`}
                  </p>
                  {candidate.pullRequests.length > 0 && (
                    <ul className="flex flex-col gap-1 text-xs">
                      {candidate.pullRequests.map((pr) => (
                        <li key={pr.number}>
                          <GithubReferenceLink
                            href={`https://github.com/${repositoryFullName}/pull/${pr.number}`}
                            className="hover:underline"
                          >
                            #{pr.number} {pr.title}
                          </GithubReferenceLink>
                          {pr.issueNumber !== null && (
                            <span className="text-muted-foreground">（Issue #{pr.issueNumber}）</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  リリースPRの後にdevelopへ入った変更が無いため、作り直しても中身が変わりません。修正をdevelopへマージしてから押してください。
                </p>
              )}

              {rebuildable && (
                <ReleaseBumpKindSelect
                  value={bumpKind}
                  onChange={setBumpKind}
                  currentVersion={mainVersion}
                  disabled={submitting}
                />
              )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={!rebuildable || submitting}
              onClick={(event) => {
                // 結果を待たずに閉じると、失敗の文言が出ず連打で多重に起動できてしまう
                event.preventDefault();
                void handleRebuild();
              }}
            >
              {submitting ? "作り直し中..." : "作り直す"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
