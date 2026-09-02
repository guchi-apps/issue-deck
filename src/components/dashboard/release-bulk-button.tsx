"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";

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
import { requestReleaseBulk } from "@/lib/release-request";

export type ReleaseBulkTarget = {
  repositoryFullName: string;
  /** 確認ダイアログに出す未リリースの件数表示（`formatUnreleasedSummary`の結果） */
  unreleasedLabel: string;
};

type ReleaseBulkButtonProps = {
  /** developがmainより進んでいて、個別の「リリースする」も押せる状態のリポジトリだけ（#2770） */
  targets: ReleaseBulkTarget[];
  /**
   * ブランチ状況を取得できず、対象に含められるか判定できなかったリポジトリの件数（#2770）。
   * 0より大きいときは確認ダイアログへ「この一覧には含まれていない」旨を添える——`targets`は
   * 判定できたものだけなので、それに気づけないままだと「まとめて出した」つもりで1件
   * 取りこぼす（計画レビュー指摘3）。
   */
  unknownRepositoryCount?: number;
  /** 起動できたリポジトリぶん、親が「起動中」表示の反映と再取得を行う */
  onTriggered: (succeededFullNames: string[]) => void;
};

/**
 * 「ブランチ」画面から、developがmainより進んでいる複数のリポジトリのリリースworkflowを
 * まとめて起動するボタン（#2770）。
 *
 * 対象は個別の「リリースする」ボタンと同じ判定（`canTriggerRelease`。`lib/branch-flow.ts`）を
 * 通したものだけを親から受け取る。**新規のGitHub API問い合わせは行わない**——「ブランチ」画面が
 * 開いた時点で既に持っているデータをそのまま使うため、対象が0件のときはボタンごと出さない
 * （Issue本文の「デプロイするものがない場合は実行しない」を満たす）。
 *
 * 起動も新規の一括APIを持たず、`repository-release-button.tsx`と同じ`requestRelease`を
 * 対象ぶんループするだけにしてある（計画レビューの指摘を受けた判断。`requestReleaseBulk`
 * 参照）。develop→mainへの実際のマージには関与しない——起動するのは各リポジトリの
 * バージョンバンプPR作成までで、mainへのマージは引き続き人が個別に行う。
 */
export function ReleaseBulkButton({
  targets,
  unknownRepositoryCount = 0,
  onTriggered,
}: ReleaseBulkButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 対象が無ければボタンごと出さない（#2770）。単一ボタンの「押せないときも消さない」
  // （#2711）とは異なり、こちらは0件のとき押す意味のある操作が1つも無いため。
  if (targets.length === 0) return null;

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      const result = await requestReleaseBulk(targets.map((target) => target.repositoryFullName));
      setConfirmOpen(false);
      onTriggered(result.succeeded);
      if (result.failed.length > 0) {
        setError(
          `${result.failed.length}件の起動に失敗しました: ${result.failed
            .map((failure) => `${failure.repoFullName}（${failure.message}）`)
            .join(" / ")}`,
        );
      }
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
        className="h-8 shrink-0 gap-1.5"
        disabled={isTriggering}
        onClick={() => setConfirmOpen(true)}
      >
        <Rocket className={isTriggering ? "size-3.5 animate-pulse" : "size-3.5"} />
        {isTriggering ? "起動中..." : `未リリース${targets.length}件をまとめてリリース`}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {targets.length}件のリポジトリでリリースworkflowを起動しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              developの変更をmainへ反映するリリースworkflowを、対象の全リポジトリで起動します。
              CI通過後は自動でdevelopへマージされ、develop→mainのPRが作られます。
              <strong className="text-foreground">mainへの実際のマージは含まれません</strong>
              （これまでどおり、各リポジトリで人が個別に行います）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* ブランチ状況を取得できず判定できなかったリポジトリがあるとき、この一覧が
              「まとめて出した」つもりで取りこぼす1件になり得ることを明示する（計画レビュー指摘3） */}
          {unknownRepositoryCount > 0 && (
            <p className="text-xs text-muted-foreground">
              このほかブランチ状況を取得できていないリポジトリが{unknownRepositoryCount}
              件あり、この一覧には含まれていません。
            </p>
          )}
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border p-2 text-xs">
            {targets.map((target) => (
              <div
                key={target.repositoryFullName}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{target.repositoryFullName}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {target.unreleasedLabel}
                </span>
              </div>
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTriggering}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={isTriggering}
              onClick={(event) => {
                // 起動の結果を待たずに閉じないよう既定の閉じる動作を止める（#1548と同じ理由）。
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
