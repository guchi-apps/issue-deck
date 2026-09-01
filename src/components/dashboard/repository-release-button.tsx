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
import { Button } from "@/components/ui/button";
import { requestRelease } from "@/lib/release-request";
import type { BumpKind } from "@/lib/semver-bump";
import type { BranchFlowIssueRef, ReleaseBlockedReason } from "@/types/branch-flow";

/**
 * 押せないときにボタンへ添える文言（#2711）。**「押せない」と「操作が無い」を区別させる**ため、
 * ボタンを消さずに理由だけを添える。
 */
const BLOCKED_REASON_LABEL: Record<ReleaseBlockedReason, string> = {
  "branches-unloaded": "ブランチ状況を取得できず",
  "no-workflow": "リリース用ワークフローがありません",
  "release-in-progress": "リリース中",
  "nothing-to-release": "出す変更がありません",
};

type RepositoryReleaseButtonProps = {
  repositoryFullName: string;
  /** 今回のリリースで本番へ出る変更の対応Issue（未リリースの束から作る） */
  pendingIssues: BranchFlowIssueRef[];
  /** 直近で本番へ出た版（`3.21.0`）。上げ幅の選択肢に「3.21.0 → 3.22.0」の目安を出すのに使う */
  currentVersion?: string | null;
  /** すでに起動済みで、バンプPRが現れるのを待っている最中か（#1955） */
  isPending: boolean;
  /**
   * 押せない理由（#2711）。渡すと、無効のボタンと理由だけを出す（確認ダイアログは持たない）。
   * nullなら今までどおり押せるボタン。
   */
  blockedReason?: ReleaseBlockedReason | null;
  /** 起動に成功したあと。起動中の記録とバンプPRの出現を反映させるための再取得を親が行う */
  onTriggered: () => void;
};

/**
 * 「ブランチ」画面からリリースworkflowを起動するボタン（#1510）。
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
 * **押せない状態でもボタンを消さない**（#2711）。`blockedReason`を受け取ったときは、無効の
 * ボタンと理由（「出す変更がありません」など）だけを出す。以前は押せないときに親が描画ごと
 * 落としていたため、「次のリリース（本番未反映）」の束から本番へ出す手段が画面のどこにも
 * 無くなり、押せないのか操作が存在しないのかを見分けられなかった。
 *
 * **一度起動したら、バンプPRが現れるまで押せない**（#1548）。起動からPRが現れるまでの数十秒は
 * `canTriggerRelease`がtrueのまま残るため、その間の連打がそのままworkflowの多重起動になっていた。
 * 起動時刻は端末のlocalStorageへ置き、判定は`useReleaseTriggerPending`が持つ——**同じ状態を
 * 畳んだ1行のピルも見るため、保持はこのボタンではなくリポジトリの節に置いてある**（#1955）。
 */
export function RepositoryReleaseButton({
  repositoryFullName,
  pendingIssues,
  currentVersion = null,
  isPending,
  blockedReason = null,
  onTriggered,
}: RepositoryReleaseButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 既定は自動判定（null）。選ばなければ起動の挙動は今までと変わらない（#1548）
  const [bumpKind, setBumpKind] = useState<BumpKind | null>(null);

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      await requestRelease(repositoryFullName, bumpKind ?? undefined);
      // 起動できたら確認ダイアログを閉じるだけにする（#1590）。以前は「リリースを起動しました」の
      // ダイアログを続けて出していたが、閉じた先のボタンが「リリース起動中…」へ変わることで
      // 起動できたことは分かるため、OKを押させるだけの一手間だった。
      setConfirmOpen(false);
      onTriggered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTriggering(false);
    }
  }

  // 押せないときは、無効のボタンと理由だけを出す（#2711）。**ボタンごと消さない**——
  // 「次のリリース（本番未反映）」と出ている束から本番へ出す手段が画面から無くなり、
  // 押せないのか操作が存在しないのかを区別できなくなるため。
  if (blockedReason) {
    return (
      <span className="flex items-center gap-1.5" title={BLOCKED_REASON_LABEL[blockedReason]}>
        <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs" disabled>
          <Rocket className="size-3" />
          リリースする
        </Button>
        <span className="text-xs text-muted-foreground">{BLOCKED_REASON_LABEL[blockedReason]}</span>
      </span>
    );
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
    </>
  );
}
