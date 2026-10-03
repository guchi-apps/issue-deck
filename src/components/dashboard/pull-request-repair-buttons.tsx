"use client";

import { useState } from "react";
import { Info, Wrench } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
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
import { usePullRequestRepairMutation } from "@/hooks/use-pull-request-repair-mutation";
import {
  isRepairWorkflowMissing,
  REPAIR_TARGET_LABEL,
  repairUnavailableNotices,
  type RepairKind,
  type RepairWorkflowAvailability,
} from "@/lib/github/pull-request-repair";
import { cn } from "@/lib/utils";

type PullRequestRepairButtonsProps = {
  repositoryFullName: string;
  pullRequestNumber: number;
  /** 出す修復ボタンの種類（`repairKindsFor`の結果）。空なら何も描かない */
  kinds: RepairKind[];
  /**
   * 起動先ワークフローが対象リポジトリに配られているか（#1960）。`false`の種類は押せなくする。
   * 判定していない経路では省略してよく、その場合は従来どおり全部押せる。
   */
  availability?: RepairWorkflowAvailability;
  /**
   * いま走っている修復の種類（#2072）。その種類のボタンを押せなくして、同じ修復が
   * 二重に起動するのを防ぐ。走っていなければ`null`（従来どおり押せる）。
   */
  runningKind?: RepairKind | null;
  className?: string;
};

/**
 * 詰まっているPRをボタン1つで直しにいく導線（#1293、#3970）。
 *
 * CIが失敗している・baseブランチとコンフリクトしている状態は、これまで人間がIssueへ
 * `@claude`コメントを書くか、GitHubのActions画面から手動実行するしか起点が無かった
 * （自動検知の経路はある。`docs/multi-agent/auto-repair.md`）。押した先で何が起きるかは
 * PRの種別で変わるが、その判定はサーバー側（`/api/pull-requests/repair`）が持つ。
 *
 * 起動は非同期でワークフローが走り始めるだけなので、完了はPRのコメントで受け取る。
 * ここでは「起動した」ことだけを画面に残す。
 *
 * **起動先のワークフローが配られていないリポジトリでは、ボタンを消さずに押せなくする**
 * （#1960。#1948の計画時点でユーザーと合意した方針）。消してしまうと「配れば使える」ことが
 * 画面から分からなくなるため、無効化したうえで理由と配り先（設定＞フリート運用）を添える。
 */
export function PullRequestRepairButtons({
  repositoryFullName,
  pullRequestNumber,
  kinds,
  availability,
  runningKind = null,
  className,
}: PullRequestRepairButtonsProps) {
  const { repairPullRequest, isSubmitting, error, setError } = usePullRequestRepairMutation();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [justStarted, setJustStarted] = useState(false);
  const [owner, repo] = repositoryFullName.split("/");
  // 押せない種類があるときだけ、理由と次の一手を添える（理由が違えば行を分ける）。
  // APIは優先順位の先頭1件だけを起動するため、今回起動するworkflowの可否だけで
  // ボタンを無効化する。後続が未配布でも、先頭の修復まで止めない。
  const nextKind = kinds[0];
  const unavailableNotices = repairUnavailableNotices([nextKind], availability);

  if (kinds.length === 0) return null;

  const hasUnavailableWorkflow = isRepairWorkflowMissing(availability, nextKind);

  async function runRepair() {
    const ok = await repairPullRequest({ owner, repo, number: pullRequestNumber });
    if (ok) {
      setIsConfirmOpen(false);
      // runningKindの反映前だけ短く起動済み表示を出す。次の再描画でrunningKindが
      // 無ければ高速完了とみなし、ボタンを復帰させる。
      setJustStarted(true);
      // repairRunの反映にはAPI成功後に時間差がある。短い猶予中は二重起動を防ぎ、
      // その間にrunningKindが観測されなかった（高速完了した）場合だけ操作を復帰させる。
      setTimeout(() => setJustStarted(false), 5_000);
    }
  }

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {justStarted ? (
        <span className="text-xs text-muted-foreground">
          PRを自動修正中です。結果はPRのコメントに届きます。
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          disabled={isSubmitting || hasUnavailableWorkflow || runningKind !== null}
          title={
            runningKind !== null
              ? "いま自動修正中です。結果はPRのコメントに届きます。"
              : hasUnavailableWorkflow
                ? unavailableNotices.join(" ")
                : undefined
          }
          onClick={() => {
            setError(null);
            setIsConfirmOpen(true);
          }}
        >
          <Wrench className="size-3.5" />
          PRを自動修正
        </Button>
      )}
      {!justStarted && runningKind !== null && (
        <span className="text-xs text-muted-foreground">
          PRを自動修正中です。結果はPRのコメントに届きます。
        </span>
      )}
      {!justStarted &&
        unavailableNotices.map((notice) => (
          <p
            key={notice}
            className="flex w-full min-w-0 items-start gap-1 text-xs text-muted-foreground"
          >
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        ))}
      {error && !isConfirmOpen && <span className="text-xs text-destructive">{error}</span>}

      <AlertDialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setIsConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>PRを自動修正しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repositoryFullName} #{pullRequestNumber} の現在の状態を取得し直し、修正が必要な項目を
              同じPRのhead branchで自動修正します。安全に直せないと判断された場合は変更を加えず、理由が報告されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="text-sm">
            <p className="font-medium">現在検出されている修正対象</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {kinds.map((kind) => (
                <li key={kind}>{REPAIR_TARGET_LABEL[kind]}</li>
              ))}
            </ul>
          </div>
          <ApiErrorMessage message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 起動結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
                // （マージボタンと同じ扱い）。
                event.preventDefault();
                runRepair();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? "起動中..." : "起動する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
