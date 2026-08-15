"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { requestRelease } from "@/lib/release-request";
import type { BranchFlowIssueRef } from "@/types/branch-flow";

type RepositoryReleaseButtonProps = {
  repositoryFullName: string;
  /** 今回のリリースで本番へ出る変更の対応Issue（未リリースの束から作る） */
  pendingIssues: BranchFlowIssueRef[];
  /** 起動に成功したあと、バンプPRの出現を反映させるための再取得 */
  onTriggered: () => void;
};

/**
 * 「ブランチとPRの流れ」からリリースworkflowを起動するボタン（#1510）。
 *
 * この画面は未リリースのコミット数もリリースPRの有無も既に持っているのに、実際に流すには
 * ヘッダーのロケットボタンへ移る必要があった。**持つのは起動だけ**で、4段の進捗と
 * mainへのマージ導線はヘッダー側（`ReleaseProgress`）に残す——ここで状態まで追うと、
 * 「追加のGitHub API取得をしない」というこの画面の前提が崩れるため。
 *
 * そのぶん、状態取得のポーリングを持つ`useReleaseStatus`ではなく`requestRelease`だけを使う。
 * 押してよいかの判定（`canTriggerRelease`）は`lib/branch-flow.ts`が済ませている。
 */
export function RepositoryReleaseButton({
  repositoryFullName,
  pendingIssues,
  onTriggered,
}: RepositoryReleaseButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      await requestRelease(repositoryFullName);
      setSuccessOpen(true);
      onTriggered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTriggering(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-xs"
        disabled={isTriggering}
        onClick={() => setConfirmOpen(true)}
      >
        <Rocket className={isTriggering ? "size-3 animate-pulse" : "size-3"} />
        {isTriggering ? "起動中..." : "リリースする"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}

      {/* 誤タップでの起動を防ぐため確認を挟む。文面はヘッダーのロケットボタンと揃えている */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースworkflowを起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repositoryFullName}のdevelopをmainへ反映するリリースworkflowを起動します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingIssues.length > 0 ? (
            <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
              <p className="text-xs font-medium text-muted-foreground">今回反映する内容</p>
              <ul className="flex flex-col gap-1 text-xs">
                {pendingIssues.map((issue) => (
                  <li key={issue.number}>
                    <GithubReferenceLink
                      href={`https://github.com/${repositoryFullName}/issues/${issue.number}`}
                      className="hover:underline"
                    >
                      #{issue.number}
                      {issue.title ? ` ${issue.title}` : ""}
                    </GithubReferenceLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              develop済みでmain未反映のIssueはありません。
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleTrigger}>起動する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={successOpen} onOpenChange={setSuccessOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースを起動しました</AlertDialogTitle>
            <AlertDialogDescription>
              バンプPRが作られるとこの画面に現れます。CIの進行やmainへのマージ待ちは、
              ヘッダーのリリースボタンで追えます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className={buttonVariants({ variant: "default" })}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
