"use client";

import { useState } from "react";
import { GitMerge, Info, Wrench } from "lucide-react";

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
  REPAIR_KIND_DESCRIPTION,
  REPAIR_KIND_LABEL,
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
  className?: string;
};

const KIND_ICON: Record<RepairKind, typeof Wrench> = {
  ci: Wrench,
  conflict: GitMerge,
};

/**
 * 詰まっているPRをボタン1つで直しにいく導線（#1293）。
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
  className,
}: PullRequestRepairButtonsProps) {
  const { repairPullRequest, isSubmitting, error, setError } = usePullRequestRepairMutation();
  const [confirmKind, setConfirmKind] = useState<RepairKind | null>(null);
  const [startedKind, setStartedKind] = useState<RepairKind | null>(null);
  const [owner, repo] = repositoryFullName.split("/");
  // 押せない種類があるときだけ、理由と次の一手を添える（理由が違えば行を分ける）。
  const unavailableNotices = repairUnavailableNotices(kinds, availability);

  if (kinds.length === 0) return null;

  async function runRepair(kind: RepairKind) {
    const ok = await repairPullRequest({ owner, repo, number: pullRequestNumber, kind });
    if (ok) {
      setConfirmKind(null);
      setStartedKind(kind);
    }
  }

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {startedKind ? (
        <span className="text-xs text-muted-foreground">
          {REPAIR_KIND_LABEL[startedKind]}のworkflowを起動しました（結果はPRのコメントに届きます）
        </span>
      ) : (
        kinds.map((kind) => {
          const Icon = KIND_ICON[kind];
          const missing = isRepairWorkflowMissing(availability, kind);
          return (
            <Button
              key={kind}
              size="sm"
              variant="outline"
              className="h-7 shrink-0"
              disabled={isSubmitting || missing}
              // 無効化の理由はホバーできない端末にも要るため下の一文でも出すが、
              // マウスで触ったときにその場で読めるようtitleにも同じ趣旨を持たせる。
              title={missing ? unavailableNotices.join(" ") : undefined}
              onClick={() => {
                setError(null);
                setConfirmKind(kind);
              }}
            >
              <Icon className="size-3.5" />
              {REPAIR_KIND_LABEL[kind]}
            </Button>
          );
        })
      )}
      {!startedKind &&
        unavailableNotices.map((notice) => (
          <p
            key={notice}
            className="flex w-full min-w-0 items-start gap-1 text-xs text-muted-foreground"
          >
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        ))}
      {error && !confirmKind && <span className="text-xs text-destructive">{error}</span>}

      <AlertDialog
        open={confirmKind !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKind(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmKind ? REPAIR_KIND_LABEL[confirmKind] : ""}を実行しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {repositoryFullName} #{pullRequestNumber} を対象に、Claude Codeによる自動修復の
              workflowを起動します。
              {confirmKind ? REPAIR_KIND_DESCRIPTION[confirmKind] : ""}
              安全に直せないと判断された場合は変更を加えず、理由が報告されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ApiErrorMessage message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 起動結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
                // （マージボタンと同じ扱い）。
                event.preventDefault();
                if (confirmKind) runRepair(confirmKind);
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
