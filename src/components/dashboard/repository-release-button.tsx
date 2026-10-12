"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";

import { ReleaseChangeList } from "@/components/dashboard/release-change-list";
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
import { Checkbox } from "@/components/ui/checkbox";
import { isPrepBlockedReason, PREP_OVERRIDE_CONFIRM_TEXT } from "@/lib/release-prep-state";
import { requestRelease } from "@/lib/release-request";
import type { BumpKind } from "@/lib/semver-bump";
import type { ReleaseBlockedReason } from "@/types/branch-flow";

/**
 * 押せないときにボタンへ添える文言（#2711）。**「押せない」と「操作が無い」を区別させる**ため、
 * ボタンを消さずに理由だけを添える。
 */
const BLOCKED_REASON_LABEL: Record<ReleaseBlockedReason, string> = {
  "branches-unloaded": "ブランチ状況を取得できず",
  "no-workflow": "リリース用ワークフローがありません",
  "release-in-progress": "リリース中",
  "nothing-to-release": "出す変更がありません",
  "deploy-failed": "本番デプロイ失敗中。修正を取り込んだ場合は手動で起動できます",
  "release-preparing": "CIとバージョン更新が自動で実行されます。操作せずお待ちください",
  "preparation-failed": "リリース準備に失敗しています。上の赤い帯で原因を確認し、「再開」してください",
  "preparation-unknown": "リリース準備の状態を確認しています",
};

/** 無効のボタンに書く文字。準備の状態は、押せない理由そのものをボタンに出す（#4421） */
const BLOCKED_BUTTON_LABEL: Partial<Record<ReleaseBlockedReason, string>> = {
  "release-preparing": "リリース準備中",
  "preparation-failed": "準備に失敗",
  "preparation-unknown": "準備状態を確認中",
};

type RepositoryReleaseButtonProps = {
  repositoryFullName: string;
  /** 直近で本番へ出た版（`3.21.0`）。上げ幅の選択肢に「3.21.0 → 3.22.0」の目安を出すのに使う */
  currentVersion?: string | null;
  /** すでに起動済みで、バンプPRが現れるのを待っている最中か（#1955） */
  isPending: boolean;
  /**
   * 押せない理由（#2711）。通常は無効のボタンと理由だけを出す。
   * `deploy-failed`だけは、明示的な上書きを選ぶ確認ダイアログを開ける（#3912）。
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
  currentVersion = null,
  isPending,
  blockedReason = null,
  onTriggered,
}: RepositoryReleaseButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowFailedDeploy, setAllowFailedDeploy] = useState(false);
  // 既定は自動判定（null）。選ばなければ起動の挙動は今までと変わらない（#1548）
  const [bumpKind, setBumpKind] = useState<BumpKind | null>(null);
  const deployFailed = blockedReason === "deploy-failed";
  // 準備中・準備失敗は灰色に見せるが、確認のうえ押せる（#4421。判定が外れても人が抜けられる）
  const prepBlocked = isPrepBlockedReason(blockedReason);
  const needsOverride = deployFailed || prepBlocked;
  const [allowPrepOverride, setAllowPrepOverride] = useState(false);

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      await requestRelease(repositoryFullName, bumpKind ?? undefined, deployFailed && allowFailedDeploy);
      setAllowPrepOverride(false);
      // 起動できたら確認ダイアログを閉じるだけにする（#1590）。以前は「リリースを起動しました」の
      // ダイアログを続けて出していたが、閉じた先のボタンが「リリース起動中…」へ変わることで
      // 起動できたことは分かるため、OKを押させるだけの一手間だった。
      setConfirmOpen(false);
      setAllowFailedDeploy(false);
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
  if (blockedReason && !deployFailed && !prepBlocked) {
    return (
      <span className="flex items-center gap-1.5" title={BLOCKED_REASON_LABEL[blockedReason]}>
        <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs" disabled>
          <Rocket className="size-3" />
          {BLOCKED_BUTTON_LABEL[blockedReason] ?? "リリースする"}
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
        className={prepBlocked ? "h-6 gap-1 bg-muted px-2 text-xs text-muted-foreground" : "h-6 gap-1 px-2 text-xs"}
        disabled={isTriggering || isPending}
        onClick={() => setConfirmOpen(true)}
      >
        <Rocket className={isTriggering || isPending ? "size-3 animate-pulse" : "size-3"} />
        {isTriggering ? "起動中..." : isPending ? "リリース起動中…" : deployFailed ? "修正リリース" : prepBlocked ? BLOCKED_BUTTON_LABEL[blockedReason] : "リリースする"}
      </Button>
      {needsOverride && blockedReason && <span className="text-xs text-muted-foreground">{BLOCKED_REASON_LABEL[blockedReason]}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}

      {/* 誤タップでの起動を防ぐため確認を挟む。文面はヘッダーのロケットボタンと揃えている */}
      <AlertDialog open={confirmOpen} onOpenChange={(open) => {
        setConfirmOpen(open);
        if (!open) {
          setAllowFailedDeploy(false);
          setAllowPrepOverride(false);
          setBumpKind(null);
        }
      }}>
        <AlertDialogContent className="flex flex-col gap-4 overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>リリースworkflowを起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repositoryFullName}のdevelopをmainへ反映するリリースworkflowを起動します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <ReleaseBumpKindSelect
            value={bumpKind}
            onChange={setBumpKind}
            currentVersion={currentVersion}
            disabled={isTriggering}
          />
          {deployFailed && (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
              <Checkbox
                checked={allowFailedDeploy}
                onCheckedChange={(checked) => setAllowFailedDeploy(checked === true)}
                disabled={isTriggering}
              />
              <span>本番デプロイの失敗を確認しました。developに取り込んだ修正をリリースするため、失敗中の起動を許可します。</span>
            </label>
          )}
          {prepBlocked && (
            <label className="flex items-start gap-2 rounded-md border border-amber-500/40 p-3 text-sm">
              <Checkbox
                checked={allowPrepOverride}
                onCheckedChange={(checked) => setAllowPrepOverride(checked === true)}
                disabled={isTriggering}
              />
              <span>{PREP_OVERRIDE_CONFIRM_TEXT[blockedReason === "preparation-failed" ? "failed" : "running"]}</span>
            </label>
          )}
          <ReleaseChangeList repositoryFullName={repositoryFullName} enabled={confirmOpen} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTriggering}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={isTriggering || (deployFailed && !allowFailedDeploy) || (prepBlocked && !allowPrepOverride)}
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
