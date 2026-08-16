"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { CreateIssueDialog } from "@/components/dashboard/create-issue-dialog";
import { broadcastIssueCreated } from "@/lib/issue-broadcast";
import { takeIssueCreateHandoff, type IssueCreateHandoff } from "@/lib/issue-create-window";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type CreateIssueWindowProps = {
  repositories: ConnectedRepository[];
  issues: Issue[];
};

/**
 * 別ウィンドウで開くIssue作成画面（`/issues/new`）の中身（#1728）。
 *
 * フォーム自体は`CreateIssueDialog`をそのまま使い、この層が受け持つのは
 * **ウィンドウとしての振る舞い**——移してきた入力内容の受け取り、閉じ方、
 * 作ったことを元のデッキへ伝えることの3つだけ。
 */
export function CreateIssueWindow({ repositories, issues }: CreateIssueWindowProps) {
  /**
   * 受け渡しの読み取りはlocalStorageに触るため、マウント後に行う（サーバー側では読めない）。
   * 読み終わるまで描画しないのは、**空のフォームが一瞬出てから値が入るのを避ける**ため。
   */
  const [state, setState] = useState<{
    handoff: IssueCreateHandoff | null;
    /** このウィンドウを開いたウィンドウがあるか。無ければ`window.close()`は効かない */
    hasOpener: boolean;
  } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ handoff: takeIssueCreateHandoff(), hasOpener: Boolean(window.opener) });
  }, []);

  /**
   * 閉じる。`window.open`で開かれたウィンドウは`window.close()`で閉じられるが、
   * URLを直接開いた場合は無視されるため、そのときはデッキへ移る（何も起きないと行き止まりになる）。
   */
  function handleClose() {
    window.close();
    window.setTimeout(() => {
      if (!window.closed) window.location.href = "/dashboard";
    }, 200);
  }

  // 受け渡しを読むまでの間。**真っ白にしない**——ウィンドウ全体がこのフォームなので、
  // 何も無い時間があると開くのに失敗したように見える
  if (!state) {
    return (
      <div className="flex h-full flex-col text-sm">
        <div className="flex flex-col gap-1 border-b px-4 py-3">
          <h1 className="font-heading text-base leading-none font-medium">新しいIssueを作成</h1>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <CreateIssueDialog
      open
      presentation="window"
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
      repositories={repositories}
      issues={issues}
      initialHandoff={state.handoff}
      defaultRepositoryFullName={state.handoff?.repositoryFullName ?? null}
      bodyPrefix={state.handoff?.bodyPrefix ?? null}
      cancelLabel={state.hasOpener ? "閉じる" : "デッキへ戻る"}
      // 作ったIssueは元のデッキの一覧へその場で加える。伝わらなくても一覧のポーリングで
      // 10秒以内に現れるため、ここでは失敗しても止めない
      onCreated={broadcastIssueCreated}
    />
  );
}
