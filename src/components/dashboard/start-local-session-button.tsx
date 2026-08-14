"use client";

import { ChevronDown, Laptop, Loader2, Server, Terminal } from "lucide-react";

import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import {
  describeDispatchEnqueueRejection,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  resolveDispatchTargetRejection,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { buildLocalSessionUrl, canStartLocalSession } from "@/lib/local-session";
import { hasSeenLocalSessionSetup, markLocalSessionSetupSeen } from "@/lib/local-session-setup";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

type StartLocalSessionButtonProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
  /** 初回起動時にセットアップ手順を見せるためのコールバック（#1088） */
  onFirstLaunch: () => void;
  /**
   * 対象リポジトリがローカル起動プロトコルに適合しているか（#1073）。
   * リポジトリ情報が見つからない場合は`undefined`。そのときは隠さない。
   *
   * **効くのは「このPC」の候補だけ**（#1224）。サブPCは汎用ランチャーでマーカー行を
   * 持たないリポジトリも起動できるため、こちらでは見ない。
   */
  hasLocalStartScript?: boolean;
  /**
   * 「このPC」を起動先の候補に入れるか（既定: 入れる）。
   *
   * **スマホの画面では`false`にする。** `issuedeck://`はブラウザを開いている端末のWindowsに
   * 登録されたハンドラを踏むもので、スマホから押しても何も起きない。押せる場所に置くこと自体が
   * 誤解になる。サブPCの申告が無ければ導線ごと出ない。
   */
  includeLocalTarget?: boolean;
  /** 縦積みのレイアウト（スマホの詳細画面）向けに、ボタンを幅いっぱいにする */
  fullWidth?: boolean;
};

/**
 * ローカルのClaude Codeセッションを、**起動先を選んで**起動するボタン（#1049・#1180）。
 *
 * 起動先は2つあり、経路がまったく違う。
 *
 * | 起動先 | 経路 | 使える場面 |
 * |---|---|---|
 * | このPC | `issuedeck://`プロトコル → WSLの受け口 | メインPCでブラウザを開いているときだけ |
 * | サブPC | ジョブをキューに積み、サブPCが取りに来る（#1179） | スマホからでも押せる。メインPCが起動していなくてよい |
 *
 * **サブPCが申告していない環境では従来どおり1つのボタンのまま**にしている。選択肢が1つしか
 * ないメニューを開かせる意味は無いため。申告があれば（応答が途絶えていても）メニューにし、
 * 応答していないホストは理由付きで押せなくする。**押せてしまうと、キューに積まれたまま
 * 誰も取りに来ないジョブが増える。**
 *
 * `11.local`を付ける理由は無人実行（claude-issue-dispatch.yml）との二重起動を防ぐため。
 * 付ける順番は経路で変える。このPCはプロトコルが登録済みかを検知できない（#1088）ので
 * 起動前に付け、サブPCは積めたかどうかが分かるので**積めたときだけ**付ける（拒否されたのに
 * ラベルだけ残ると、無人実行までそのIssueに触れなくなる）。
 *
 * **起動先ごとに可否の判定材料が違う**（#1224）。ここを1つのゲートにまとめない。
 *
 * | 起動先 | 判定材料 | 理由 |
 * |---|---|---|
 * | このPC | `hasLocalStartScript`（GitHub上のマーカー行・#1073） | 対象リポジトリの`start-issue.sh`をそのまま呼ぶ経路なので、適合していなければ受け口で止まる |
 * | サブPC | サブPCの申告（`resolveDispatchTargetRejection`） | 汎用ランチャーでマーカー行の無いリポジトリも起動できる。**実際にcloneされ起動できるかを知っているのはサブPC側だけ** |
 */
export function StartLocalSessionButton({
  issue,
  onIssueUpdated,
  onFirstLaunch,
  hasLocalStartScript,
  includeLocalTarget,
  fullWidth,
}: StartLocalSessionButtonProps) {
  const { updateIssue, isSubmitting, error } = useIssueMutations();

  const sessionUrl = buildLocalSessionUrl(issue.repositoryFullName, issue.number);
  // 「このPC」を候補に入れるか。呼び出し側の指定（スマホでは入れない）と、対象リポジトリが
  // ローカル起動プロトコルに適合しているか（#1073）の両方を満たしたときだけ
  const hasLocalTarget = includeLocalTarget !== false && canStartLocalSession(hasLocalStartScript);
  // closedなIssueは起動しても実装対象が無い。リポジトリ名が壊れている場合はURLを組み立てられない
  const isAvailable = sessionUrl !== null && issue.state === "open";
  // フックは早期returnより前に、常に同じ順で呼ぶ必要がある。導線を出さない場合は取得もしない
  const dispatch = useDispatchState(isAvailable);

  if (!sessionUrl || !isAvailable) return null;
  // 関数宣言は巻き上げられるため、上のnarrowingがhandleStartHere内へ伝わらない。改めて束ね直す。
  const localUrl: string = sessionUrl;

  const job = findDispatchJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveJob = job !== null && isActiveDispatchJobStatus(job.status);
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

  async function handleStartHere() {
    await ensureLocalLabel();
    // プロトコル未登録の環境ではブラウザ側で無視されるだけで、ページ遷移は起きない。
    // その場合のフォールバックは「…」メニューの「ローカル起動コマンドをコピー」。
    window.location.href = localUrl;

    // 未登録かどうかは検知できない（#1088）ため、初回だけこちらからセットアップ手順を見せる。
    // 登録済みの環境では余計だが、一度きりなので押し付けにはならない。
    if (!hasSeenLocalSessionSetup()) {
      markLocalSessionSetupSeen();
      onFirstLaunch();
    }
  }

  async function handleDispatch(hostName: string) {
    const enqueued = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName,
    });
    if (enqueued) await ensureLocalLabel();
  }

  // 起動先が1つしか無いならメニューを開かせない。メインPCで見ているときのサブPC未申告
  // （このPCのみ）と、スマホから見ているとき（サブPCのみ）の両方がここに当たる
  const onlyHost =
    !hasLocalTarget && dispatch.hosts.length === 1 ? (dispatch.hosts[0] ?? null) : null;
  const onlyHostRejection = onlyHost
    ? resolveDispatchTargetRejection({
        host: onlyHost,
        repositoryFullName: issue.repositoryFullName,
        hasActiveJob,
      })
    : null;

  // 起動先が1つも無い（スマホから見ていてサブPCの申告が無い）場合は導線を出さない
  if (!hasLocalTarget && dispatch.hosts.length === 0) return null;

  // 横並びのツールバー（PC）では右寄せ、縦積み（スマホ）では左寄せに揃える
  const textClassName = cn(
    "w-full break-words text-sm",
    fullWidth ? "text-left" : "text-right",
    "text-muted-foreground",
  );

  // 起動先が2つ以上あるときだけメニューにする
  const layout = onlyHost ? "host-only" : dispatch.hosts.length === 0 ? "local-only" : "menu";

  return (
    <>
      {layout === "host-only" && onlyHost ? (
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
      ) : layout === "local-only" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleStartHere()}
          disabled={isBusy}
          title="WSL上にworktreeと開発サーバーを用意し、Claude Codeセッションを起動します（初回のみプロトコル登録が必要）"
        >
          {isBusy ? <Loader2 className="animate-spin" /> : <Terminal />}
          ローカルで開始
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
              {isBusy ? <Loader2 className="animate-spin" /> : <Terminal />}
              {hasLocalTarget ? "ローカルで開始" : "サブPCで開始"}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          {/* スマホの画面幅（サブPC起動の主な用途）でも収まるよう、幅は画面からはみ出さない */}
          <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              起動先を選ぶ
            </DropdownMenuLabel>
            {hasLocalTarget && (
              <DropdownMenuItem
                className="flex-col items-start gap-0.5"
                onSelect={() => void handleStartHere()}
              >
                <span className="flex items-center gap-2 font-medium">
                  <Laptop className="size-3.5" />
                  このPC
                </span>
                <span className="whitespace-normal text-xs text-muted-foreground">
                  メインPC（WSL）でターミナルが開きます。この画面を開いている端末が必要です
                </span>
              </DropdownMenuItem>
            )}
            {dispatch.hosts.map((host) => (
              <DispatchHostMenuItem
                key={host.name}
                host={host}
                jobs={dispatch.jobs}
                concurrency={dispatch.concurrency}
                repositoryFullName={issue.repositoryFullName}
                hasActiveJob={hasActiveJob}
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
  onSelect,
}: {
  host: DispatchHostView;
  jobs: DispatchJobView[];
  concurrency: number | null;
  repositoryFullName: string;
  hasActiveJob: boolean;
  onSelect: () => void;
}) {
  const rejection = resolveDispatchTargetRejection({ host, repositoryFullName, hasActiveJob });
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
    ? describeDispatchEnqueueRejection(rejection, { hostName: host.name, repositoryFullName })
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
