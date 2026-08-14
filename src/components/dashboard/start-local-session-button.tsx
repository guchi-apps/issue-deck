"use client";

import { ChevronDown, Loader2, Server } from "lucide-react";

import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import {
  describeDispatchEnqueueRejection,
  findBlockingSession,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  resolveDispatchTargetRejection,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { parseRepositoryFullName } from "@/lib/local-session";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

type StartLocalSessionButtonProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
  /** 縦積みのレイアウト（スマホの詳細画面）向けに、ボタンを幅いっぱいにする */
  fullWidth?: boolean;
  /**
   * 親が既に取得しているディスパッチ状態（#1262）。渡すと自前で取得しない。
   * **同じ画面に取得口を増やさないため**、Issue詳細では親で1回だけ取得して配る。
   */
  dispatch?: DispatchStateHandle;
};

/**
 * サブPCのClaude Codeセッションを起動するボタン（#1179・#1180）と、積んだジョブの状態表示。
 *
 * **起動先が「このPC」だった経路（`issuedeck://`）は#1263で廃止した。** 手元で作業するときは
 * VS Codeを自分で開いているので、必要なのはセッションを丸ごと立てることではなく開いている
 * セッションへ貼れる文面で、そちらは「実装を開始」ダイアログの実行先に並べている。
 *
 * このボタンが残っているのは、**ダイアログが閉じたあとに積んだ結果を出す場所が要る**ため
 * （順番待ち・起動中・失敗。#1248）。起動そのものはダイアログからでもここからでも行える。
 *
 * `11.local`は**積めたときだけ**付ける。拒否されたのにラベルだけ残ると、無人実行まで
 * そのIssueに触れなくなる。
 */
export function StartLocalSessionButton({
  issue,
  onIssueUpdated,
  fullWidth,
  dispatch: injectedDispatch,
}: StartLocalSessionButtonProps) {
  const { updateIssue, isSubmitting, error } = useIssueMutations();

  // closedなIssueは起動しても実装対象が無い。リポジトリ名が壊れている場合は起動先へ渡せない。
  // 手作業Issue（`71.manual-step`）も同じく起動先が無い（実行者が人）ので出さない（#1280）
  const isAvailable =
    parseRepositoryFullName(issue.repositoryFullName) !== null &&
    issue.state === "open" &&
    !isManualStepIssue(issue.labels);
  // フックは早期returnより前に、常に同じ順で呼ぶ必要がある。導線を出さない場合は取得もしない。
  // 親から渡されている場合はそちらを使い、自前の取得は止める（#1262）
  const ownDispatch = useDispatchState(injectedDispatch === undefined && isAvailable);
  const dispatch = injectedDispatch ?? ownDispatch;

  if (!isAvailable) return null;

  const job = findDispatchJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveJob = job !== null && isActiveDispatchJobStatus(job.status);
  // 起動済み（セッション生存中）のIssueは積ませない（#1311）
  const blockingSession = findBlockingSession({
    sessions: dispatch.sessions,
    hosts: dispatch.hosts,
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
  });
  const isBusy = isSubmitting || dispatch.isSubmitting;

  /**
   * 起動前に`11.local`を付ける。**失敗しても起動自体は妨げない**
   * （起動できないより、ラベルが遅れる方が軽い）。
   */
  async function ensureLocalLabel() {
    const labelNames = issue.labels.map((label) => label.name);
    if (labelNames.includes(LOCAL_LABEL_NAME)) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: [...labelNames, LOCAL_LABEL_NAME],
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleDispatch(hostName: string) {
    const enqueued = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName,
    });
    if (enqueued) await ensureLocalLabel();
  }

  // 起動先が1つしか無いならメニューを開かせない。選択肢が1つのメニューを開かせる意味が無い
  const onlyHost = dispatch.hosts.length === 1 ? (dispatch.hosts[0] ?? null) : null;
  const onlyHostRejection = onlyHost
    ? resolveDispatchTargetRejection({
        host: onlyHost,
        repositoryFullName: issue.repositoryFullName,
        hasActiveJob,
        blockingSession,
      })
    : null;

  // 申告しているサブPCが1台も無ければ導線を出さない（起動を届ける先が無い）
  if (dispatch.hosts.length === 0) return null;

  // 横並びのツールバー（PC）では右寄せ、縦積み（スマホ）では左寄せに揃える
  const textClassName = cn(
    "w-full break-words text-sm",
    fullWidth ? "text-left" : "text-right",
    "text-muted-foreground",
  );

  return (
    <>
      {onlyHost ? (
        <Button
          variant="outline"
          size={fullWidth ? "default" : "sm"}
          className={fullWidth ? "w-full" : undefined}
          onClick={() => void handleDispatch(onlyHost.name)}
          disabled={isBusy || onlyHostRejection !== null}
        >
          {isBusy ? <Loader2 className="animate-spin" /> : <Server />}
          {onlyHost.name}で開始
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size={fullWidth ? "default" : "sm"}
              className={fullWidth ? "w-full" : undefined}
              disabled={isBusy}
            >
              {isBusy ? <Loader2 className="animate-spin" /> : <Server />}
              サブPCで開始
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          {/* スマホの画面幅（サブPC起動の主な用途）でも収まるよう、幅は画面からはみ出さない */}
          <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              起動先を選ぶ
            </DropdownMenuLabel>
            {dispatch.hosts.map((host) => (
              <DispatchHostMenuItem
                key={host.name}
                host={host}
                jobs={dispatch.jobs}
                concurrency={dispatch.concurrency}
                repositoryFullName={issue.repositoryFullName}
                hasActiveJob={hasActiveJob}
                blockingSession={blockingSession}
                onSelect={() => void handleDispatch(host.name)}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* 単独ボタンでは理由をtitle属性に隠せない（スマホにホバーが無い）ため本文で出す */}
      {onlyHostRejection && (
        <p className={textClassName}>
          {describeDispatchEnqueueRejection(onlyHostRejection, {
            hostName: onlyHost?.name ?? "",
            repositoryFullName: issue.repositoryFullName,
            session: blockingSession,
          })}
        </p>
      )}
      {job && (
        <DispatchJobStatus
          job={job}
          align={fullWidth ? "start" : "end"}
          isSubmitting={dispatch.isSubmitting}
          onCancel={() => void dispatch.cancel(job.id)}
        />
      )}
      {(error || dispatch.error) && (
        <p className={cn(textClassName, "text-destructive")}>{error ?? dispatch.error}</p>
      )}
    </>
  );
}

/**
 * 起動先1件ぶんのメニュー項目。**選べない場合は理由を添えて押せなくする**（#1180）。
 * 理由の判定と文言はAPI側（`enqueueDispatchJob`）と同じものを使う。
 */
function DispatchHostMenuItem({
  host,
  jobs,
  concurrency,
  repositoryFullName,
  hasActiveJob,
  blockingSession,
  onSelect,
}: {
  host: DispatchHostView;
  jobs: DispatchJobView[];
  concurrency: number | null;
  repositoryFullName: string;
  hasActiveJob: boolean;
  blockingSession: DispatchSessionView | null;
  onSelect: () => void;
}) {
  const rejection = resolveDispatchTargetRejection({
    host,
    repositoryFullName,
    hasActiveJob,
    blockingSession,
  });
  const hostJobs = jobs.filter((job) => job.targetHost === host.name);
  const running = hostJobs.filter(
    (job) => job.status === "CLAIMED" || job.status === "RUNNING",
  ).length;
  const queued = hostJobs.filter((job) => job.status === "QUEUED").length;

  // 積めるときは滞留具合を出す。上限に達していれば、押しても順番待ちになると分かる
  const load = [
    concurrency === null ? `実行中 ${running}` : `実行中 ${running}/${concurrency}`,
    queued > 0 ? `待機 ${queued}` : null,
  ]
    .filter(Boolean)
    .join("・");

  const description = rejection
    ? describeDispatchEnqueueRejection(rejection, {
        hostName: host.name,
        repositoryFullName,
        session: blockingSession,
      })
    : `ジョブを積みます。${host.name}が取りに来た時点で起動します（${load}）`;

  return (
    <DropdownMenuItem
      className="flex-col items-start gap-0.5"
      disabled={rejection !== null}
      onSelect={onSelect}
    >
      <span className="flex items-center gap-2 font-medium">
        <Server className="size-3.5" />
        {host.name}
      </span>
      <span className="whitespace-normal text-xs text-muted-foreground">{description}</span>
    </DropdownMenuItem>
  );
}
