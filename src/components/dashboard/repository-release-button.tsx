"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";

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
import { Button, buttonVariants } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { requestRelease } from "@/lib/release-request";
import { isReleaseTriggerPending } from "@/lib/release-trigger-guard";
import type { BumpKind } from "@/lib/semver-bump";
import type { BranchFlowIssueRef } from "@/types/branch-flow";

type RepositoryReleaseButtonProps = {
  repositoryFullName: string;
  /** 今回のリリースで本番へ出る変更の対応Issue（未リリースの束から作る） */
  pendingIssues: BranchFlowIssueRef[];
  /** 直近で本番へ出た版（`3.21.0`）。上げ幅の選択肢に「3.21.0 → 3.22.0」の目安を出すのに使う */
  currentVersion?: string | null;
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
 * （#1548でmainへのマージだけはこの画面にも置いたが、それも取得済みのPR一覧だけで成立する。）
 *
 * そのぶん、状態取得のポーリングを持つ`useReleaseStatus`ではなく`requestRelease`だけを使う。
 * 押してよいかの判定（`canTriggerRelease`）は`lib/branch-flow.ts`が済ませている。
 *
 * **一度起動したら、バンプPRが現れるまで押せない**（#1548）。起動からPRが現れるまでの数十秒は
 * `canTriggerRelease`がtrueのまま残るため、その間の連打がそのままworkflowの多重起動になっていた。
 * 起動時刻は端末のlocalStorageへ置き、判定は`isReleaseTriggerPending`が持つ。
 */
export function RepositoryReleaseButton({
  repositoryFullName,
  pendingIssues,
  currentVersion = null,
  onTriggered,
}: RepositoryReleaseButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 既定は自動判定（null）。選ばなければ起動の挙動は今までと変わらない（#1548）
  const [bumpKind, setBumpKind] = useState<BumpKind | null>(null);
  const [triggeredAt, setTriggeredAt] = usePersistedState<string | null>(
    `issue-deck:release-triggered-at:${repositoryFullName}`,
    null,
  );
  // 経過で自動的に押せる状態へ戻すため、時刻を定期的に取り直す（描画中にDate.now()を呼ばない）
  const now = useNow(30_000);
  const isPending = now !== null && isReleaseTriggerPending(triggeredAt, now);

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      await requestRelease(repositoryFullName, bumpKind ?? undefined);
      setTriggeredAt(new Date().toISOString());
      setConfirmOpen(false);
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
        disabled={isTriggering || isPending}
        onClick={() => setConfirmOpen(true)}
      >
        <Rocket className={isTriggering || isPending ? "size-3 animate-pulse" : "size-3"} />
        {isTriggering ? "起動中..." : isPending ? "リリース起動中…" : "リリースする"}
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
          <ReleaseBumpKindSelect
            value={bumpKind}
            onChange={setBumpKind}
            currentVersion={currentVersion}
            disabled={isTriggering}
          />
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
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTriggering}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={isTriggering}
              onClick={(event) => {
                // 起動の結果を待たずに閉じないよう既定の閉じる動作を止める。閉じてしまうと
                // 連打で複数回dispatchできてしまい、失敗しても文言が出ない（#1548）。
                event.preventDefault();
                void handleTrigger();
              }}
            >
              {isTriggering ? "起動中..." : "起動する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={successOpen} onOpenChange={setSuccessOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースを起動しました</AlertDialogTitle>
            <AlertDialogDescription>
              バンプPRが作られるとこの画面に現れます。それまでボタンは「リリース起動中…」のまま
              押せません。CIの進行やmainへのマージ待ちは、この画面と（詳しくは）ヘッダーの
              リリースボタンで追えます。
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
