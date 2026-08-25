"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  FileCode2,
  GitPullRequestArrow,
  Loader2,
  RefreshCw,
  Tag,
  Wrench,
} from "lucide-react";

import { FleetRepositoryRow } from "@/components/dashboard/fleet-repository-row";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useWorkflowTags } from "@/hooks/use-workflow-tags";
import {
  propagationTargets,
  repairPropagationTargets,
  repairPropagationWorkflows,
  repairWorkflowLabel,
  sharedFileLabel,
  sharedFilePropagationTargets,
  shortWorkflowTag,
  workflowTagGroup,
  type WorkflowTagStatus as Status,
} from "@/lib/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグを一覧し、更新を起こす（#985・#1173）。
 *
 * **なぜ画面に出すか。** 共有ワークフローは`uses:`のタグ固定で配っており、issue-deck側を
 * 直しても各リポジトリのcallerを上げるまで反映されない。**上げ忘れても何も起きないため
 * 気づけない。** 実際`workflows/v10`はcar-careだけに配られ、他9リポジトリは`v9`のまま
 * だった（#1147の修正が届いていない状態）。
 *
 * **一覧は状態でグループ分けする**（#1602）。14リポジトリが同じ文言（「`v18`」「`v19`へ未更新」）
 * を繰り返すだけの一覧は、何件が未更新なのかを数えないと分からなかった。状態は見出しへ、
 * タグは`v18 → v19`の1表現へ寄せ、最新のものは既定でたたむ。
 */

/** 参照しているタグ。同じタグに揃っていれば1つ、混在していれば全部を出す */
function summarizeTags(status: Status): string {
  return [...new Set(status.refs.map((ref) => shortWorkflowTag(ref.uses)))].join(" / ");
}

/** 件数のチップ。0件のものは出さない（並ぶだけで読み取る手間が増える） */
function CountChip({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "warn" | "pending" | "ok";
}) {
  if (count === 0) return null;

  const toneClass =
    tone === "warn"
      ? "border-amber-500/40 text-amber-600 dark:text-amber-500"
      : tone === "pending"
        ? "border-border text-muted-foreground"
        : "border-border text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${toneClass}`}
    >
      {label} {count}
    </span>
  );
}

/**
 * 一覧の1行。アイコン・リポジトリ名・タグ・（あれば）補足を`FleetRepositoryRow`へ載せる。
 *
 * **不一致の警告は結果と同じ段に置かない**（#1952）。以前は結果側を`ml-auto shrink-0`で
 * 右端に固定していたため、`uses と prompts-ref が不一致`が入るとスマホ幅で画面の外へ出て、
 * 先にリポジトリ名（`truncate`）が欠けていた。
 */
function RepositoryRow({
  status,
  latest,
  running,
}: {
  status: Status;
  latest: string | null;
  running: boolean;
}) {
  const group = workflowTagGroup(status);
  const to = latest ? shortWorkflowTag(latest) : null;

  return (
    <FleetRepositoryRow
      fullName={status.fullName}
      icon={
        group === "latest" ? (
          <Check className="size-3.5 text-muted-foreground" />
        ) : group === "pull-request" ? (
          <GitPullRequestArrow className="size-3.5 text-muted-foreground" />
        ) : running ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <AlertTriangle
            className={`size-3.5 ${status.mismatched ? "text-destructive" : "text-amber-500"}`}
          />
        )
      }
      result={
        <span className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground tabular-nums">
          <span>{summarizeTags(status)}</span>
          {group !== "latest" && to && (
            <>
              <span>→</span>
              <span className="font-medium text-amber-600 dark:text-amber-500">{to}</span>
            </>
          )}
          {status.updatePullRequest && (
            <a
              className="inline-flex items-center gap-0.5 underline underline-offset-2"
              href={status.updatePullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              PR #{status.updatePullRequest.number}
              <ExternalLink className="size-3" />
            </a>
          )}
        </span>
      }
      detail={status.mismatched ? "uses と prompts-ref が不一致" : null}
    />
  );
}

/** グループの見出し。右へ細い罫線を伸ばして区切りにする */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * callerが不足している・壊れているリポジトリの1行（#1948・#1475・#2330）。
 *
 * 何が不足しているかまで出す。**リポジトリによって不足するものが違う**（リリースフローを
 * 持たないリポジトリには`claude-pr-repair.yml`を配らない）ため、件数だけでは何が配られるのか
 * 分からない。
 *
 * **壊れているものは「（壊れています）」を添えて区別する**（#2330）。不足は「まだ動いて
 * いない」だけだが、壊れているcallerは**pushのたびに失敗して通知を飛ばし続ける**ので、
 * 同じ一覧に混ぜたまま見分けが付かないと後回しにされる。
 */
function RepairRow({ status, running }: { status: Status; running: boolean }) {
  const labels = [
    ...status.missingRepairWorkflows.map(repairWorkflowLabel),
    ...status.brokenRepairWorkflows.map((file) => `${repairWorkflowLabel(file)}（壊れています）`),
  ];
  return (
    <FleetRepositoryRow
      fullName={status.fullName}
      icon={
        status.repairPullRequest ? (
          <GitPullRequestArrow className="size-3.5 text-muted-foreground" />
        ) : running ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : status.brokenRepairWorkflows.length > 0 ? (
          <Wrench className="size-3.5 text-destructive" />
        ) : (
          <Wrench className="size-3.5 text-amber-500" />
        )
      }
      result={
        // 不足しているワークフロー名は3件つながると長い。折り返して全文を出す（#1952）
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 break-words text-muted-foreground">
          <span>{labels.join(" / ")}</span>
          {status.repairPullRequest && (
            <a
              className="inline-flex items-center gap-0.5 underline underline-offset-2"
              href={status.repairPullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              PR #{status.repairPullRequest.number}
              <ExternalLink className="size-3" />
            </a>
          )}
        </span>
      }
    />
  );
}

/**
 * 配布物（ワークフロー以外）が古いリポジトリの1行（#2240）。
 *
 * **独自の変更があるものは目印を出す。** 配布は中身をそのまま上書きするため、配布先の
 * コピーにしか無い記述は消える。実際`guchi-apps/subpc`のコピーには、そのリポジトリだけの
 * `NOTIFY_NOTE`が入っている。**対象からは外さない**——独自の変更があるリポジトリこそ修正が
 * 届いていないので、消える記述をPR本文へ書き出したうえで人が読む形にする。
 */
function SharedFileRow({ status, running }: { status: Status; running: boolean }) {
  const customized = status.customizedSharedFiles.length > 0;

  return (
    <FleetRepositoryRow
      fullName={status.fullName}
      icon={
        status.sharedFilePullRequest ? (
          <GitPullRequestArrow className="size-3.5 text-muted-foreground" />
        ) : running ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <FileCode2 className={`size-3.5 ${customized ? "text-destructive" : "text-amber-500"}`} />
        )
      }
      result={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 break-words text-muted-foreground">
          <span>{status.outdatedSharedFiles.map(sharedFileLabel).join(" / ")}</span>
          {status.sharedFilePullRequest && (
            <a
              className="inline-flex items-center gap-0.5 underline underline-offset-2"
              href={status.sharedFilePullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              PR #{status.sharedFilePullRequest.number}
              <ExternalLink className="size-3" />
            </a>
          )}
        </span>
      }
      detail={customized ? "独自の変更あり（上書きで消える記述がある）" : null}
    />
  );
}

export function WorkflowTagStatusSection({ open }: { open: boolean }) {
  const {
    overview,
    isLoading,
    error,
    isRunning,
    isRepairRunning,
    isSharedFileRunning,
    reload,
    markDispatched,
  } = useWorkflowTags(open);
  const [autoMerge, setAutoMerge] = useState(true);
  const [isDispatching, setIsDispatching] = useState(false);
  const [propagateMessage, setPropagateMessage] = useState<string | null>(null);
  const [propagateError, setPropagateError] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [isRepairDispatching, setIsRepairDispatching] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [isSharedFileDispatching, setIsSharedFileDispatching] = useState(false);
  const [sharedFileMessage, setSharedFileMessage] = useState<string | null>(null);
  const [sharedFileError, setSharedFileError] = useState<string | null>(null);

  const repositories = overview?.repositories ?? [];
  const targets = propagationTargets(repositories);
  const pending = repositories.filter((status) => workflowTagGroup(status) === "pull-request");
  const upToDate = repositories.filter((status) => workflowTagGroup(status) === "latest");
  const latestLabel = overview?.latest ? shortWorkflowTag(overview.latest) : null;
  const run = overview?.propagation ?? null;
  const repairRun = overview?.repairPropagation ?? null;
  // 不足しているリポジトリ。配布PRが既に出ているものは対象から外し、下に分けて出す（#1948）
  const repairTargets = repairPropagationTargets(repositories);
  const repairPending = repositories.filter(
    (status) => repairPropagationWorkflows(status).length > 0 && status.repairPullRequest !== null,
  );
  const sharedFileRun = overview?.sharedFilePropagation ?? null;
  // 配布物が古いリポジトリ。更新PRが既に出ているものは対象から外し、下に分けて出す（#2240）
  const sharedFileTargets = sharedFilePropagationTargets(repositories);
  const sharedFilePending = repositories.filter(
    (status) => status.outdatedSharedFiles.length > 0 && status.sharedFilePullRequest !== null,
  );

  /**
   * 配布を起動する（#1173）。`withNewTag`が真なら**次の版数を`main`に切ってから**配る（#1876）。
   *
   * タグを切る操作だけが手作業Issueとして残っていた（v20・v21・v22で毎回起票された）ため、
   * 同じボタンの並びから通せるようにしている。
   */
  async function handlePropagate(withNewTag = false) {
    setIsDispatching(true);
    setPropagateMessage(null);
    setPropagateError(null);
    try {
      const endpoint = withNewTag ? "/api/workflow-tags/release" : "/api/workflow-tags/propagate";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMerge }),
      });
      const payload = await res.json().catch(() => ({}));
      // `/release`は`{ tag, propagation }`、`/propagate`は配布の結果をそのまま返す
      const result: {
        dispatched: boolean;
        tag: string | null;
        repositories: string[];
        message?: string;
      } = withNewTag
        ? ((payload as { propagation?: unknown }).propagation ?? {
            dispatched: false,
            tag: (payload as { tag?: { tag?: string | null } }).tag?.tag ?? null,
            repositories: [],
            message: (payload as { tag?: { message?: string } }).tag?.message,
          })
        : payload;

      if (!res.ok) throw new Error(result.message ?? `起動に失敗しました (${res.status})`);

      if (result.dispatched) {
        // runが見えるまでのあいだも実行中として扱わせる（この間に押せると二重起動になる）
        markDispatched();
        setPropagateMessage(
          autoMerge
            ? `${result.repositories.length}件のリポジトリへ ${result.tag} のPRを作成しています。CIが通り次第、自動でマージされます。`
            : `${result.repositories.length}件のリポジトリへ ${result.tag} のPRを作成しています。GitHub Actionsの完了後、各リポジトリでPRを確認してください。`,
        );
      } else {
        setPropagateMessage(result.message ?? "更新が必要なリポジトリはありません。");
        reload();
      }
    } catch (err) {
      setPropagateError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDispatching(false);
    }
  }

  /**
   * 不足している自動修復のcallerを配る（#1948）。
   *
   * **自動マージの選択は無い。** 配るのは新しいワークフローファイルそのもので、
   * `@workflows/vN`の置換（#1602で自動マージの例外にしたもの）とは別物のため、
   * 配布先のPRは人が確認してマージする。
   */
  async function handleRepairPropagate() {
    setIsRepairDispatching(true);
    setRepairMessage(null);
    setRepairError(null);
    try {
      const res = await fetch("/api/workflow-tags/propagate-repair", { method: "POST" });
      const result: {
        dispatched: boolean;
        targets: { repository: string; workflows: string[] }[];
        message?: string;
      } = await res.json().catch(() => ({ dispatched: false, targets: [] }));

      if (!res.ok) throw new Error(result.message ?? `起動に失敗しました (${res.status})`);

      if (result.dispatched) {
        // runが見えるまでのあいだも実行中として扱わせる（この間に押せると二重起動になる）
        markDispatched();
        setRepairMessage(
          `${result.targets.length}件のリポジトリへ不足しているワークフローを追加するPRを作成しています。GitHub Actionsの完了後、各リポジトリでPRを確認してマージしてください。`,
        );
      } else {
        setRepairMessage(result.message ?? "不足しているリポジトリはありません。");
        reload();
      }
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRepairDispatching(false);
    }
  }

  /**
   * 配布物（ワークフロー以外）を最新版へ更新する（#2240）。
   *
   * **自動マージの選択は無い。** 中身をそのまま上書きするため配布先の独自の変更を消しうる
   * （実際`subpc`のコピーには`NOTIFY_NOTE`がある）。配布先のPRは人が確認してマージする。
   */
  async function handleSharedFilePropagate() {
    setIsSharedFileDispatching(true);
    setSharedFileMessage(null);
    setSharedFileError(null);
    try {
      const res = await fetch("/api/workflow-tags/propagate-shared", { method: "POST" });
      const result: {
        dispatched: boolean;
        targets: { repository: string; files: string[] }[];
        message?: string;
      } = await res.json().catch(() => ({ dispatched: false, targets: [] }));

      if (!res.ok) throw new Error(result.message ?? `起動に失敗しました (${res.status})`);

      if (result.dispatched) {
        // runが見えるまでのあいだも実行中として扱わせる（この間に押せると二重起動になる）
        markDispatched();
        setSharedFileMessage(
          `${result.targets.length}件のリポジトリへ共有スクリプトを更新するPRを作成しています。GitHub Actionsの完了後、各リポジトリでPRを確認してマージしてください。`,
        );
      } else {
        setSharedFileMessage(result.message ?? "更新が必要なリポジトリはありません。");
        reload();
      }
    } catch (err) {
      setSharedFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSharedFileDispatching(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">共有ワークフローのバージョン</span>
        <div className="flex items-center gap-1.5">
          {latestLabel && (
            <span className="rounded-full border px-2 py-0.5 text-[11px] tabular-nums">
              最新 {latestLabel}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={reload}
            disabled={isLoading}
            aria-label="再取得"
          >
            <RefreshCw className={isLoading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {propagateError && <p className="text-sm text-destructive">{propagateError}</p>}

      {!error && isLoading && !overview && (
        <p className="text-xs text-muted-foreground">読み込み中...</p>
      )}

      {overview && !overview.latest && (
        <p className="text-xs text-muted-foreground">
          issue-deck側の最新タグを取得できませんでした。
        </p>
      )}

      {overview && repositories.length === 0 && (
        <p className="text-xs text-muted-foreground">
          共有ワークフローを参照しているリポジトリはありません。
        </p>
      )}

      {repositories.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <CountChip count={targets.length} label="未更新" tone="warn" />
            <CountChip count={pending.length} label="更新PR待ち" tone="pending" />
            <CountChip count={upToDate.length} label="最新" tone="ok" />
          </div>

          {targets.length > 0 && (
            <>
              <GroupLabel>更新が必要（{targets.length}）</GroupLabel>
              <ul className="flex flex-col">
                {targets.map((status) => (
                  <RepositoryRow
                    key={status.fullName}
                    status={status}
                    latest={overview?.latest ?? null}
                    running={isRunning}
                  />
                ))}
              </ul>
            </>
          )}

          {pending.length > 0 && (
            <>
              <GroupLabel>更新PRの確認待ち（{pending.length}）</GroupLabel>
              <ul className="flex flex-col">
                {pending.map((status) => (
                  <RepositoryRow
                    key={status.fullName}
                    status={status}
                    latest={overview?.latest ?? null}
                    running={false}
                  />
                ))}
              </ul>
            </>
          )}

          {upToDate.length > 0 && (
            <Collapsible open={showLatest} onOpenChange={setShowLatest}>
              <GroupLabel>
                <CollapsibleTrigger className="inline-flex items-center gap-0.5 hover:underline">
                  <ChevronRight
                    className={`size-3 transition-transform ${showLatest ? "rotate-90" : ""}`}
                  />
                  最新（{upToDate.length}）
                </CollapsibleTrigger>
              </GroupLabel>
              <CollapsibleContent>
                <ul className="flex flex-col">
                  {upToDate.map((status) => (
                    <RepositoryRow
                      key={status.fullName}
                      status={status}
                      latest={overview?.latest ?? null}
                      running={false}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {targets.length > 0 && (
        <>
          <Button
            variant="default"
            size="sm"
            className="mt-1 w-full"
            onClick={() => void handlePropagate(false)}
            disabled={isDispatching || isRunning}
          >
            {isDispatching || isRunning ? (
              <Loader2 className="animate-spin" />
            ) : (
              <GitPullRequestArrow />
            )}
            {isRunning
              ? "更新を実行中..."
              : `${targets.length}件を ${latestLabel ?? "最新"} へ更新する`}
          </Button>

          {/* **配るタグを切るのも同じ並びに置く**（#1876）。切る操作だけが手作業Issueとして
              残っていた。`main`に対して切るので、developの内容は配られない */}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void handlePropagate(true)}
            disabled={isDispatching || isRunning}
          >
            {isDispatching || isRunning ? <Loader2 className="animate-spin" /> : <Tag />}
            新しいタグを切って配る
          </Button>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={autoMerge}
              onCheckedChange={(checked) => setAutoMerge(checked === true)}
              disabled={isDispatching || isRunning}
            />
            作成したPRを自動でマージする
          </label>
        </>
      )}

      {isRunning && run && (
        <p className="text-xs text-muted-foreground">
          各リポジトリへPRを作成しています。{" "}
          <a
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            href={run.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            実行を見る
            <ExternalLink className="size-3" />
          </a>
        </p>
      )}

      {propagateMessage && <p className="text-xs text-muted-foreground">{propagateMessage}</p>}

      {(repairTargets.length > 0 || repairPending.length > 0) && (
        <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
          <span className="text-sm font-medium">不足・破損しているワークフロー</span>

          {repairError && <p className="text-sm text-destructive">{repairError}</p>}

          {repairTargets.length > 0 && (
            <>
              <GroupLabel>未配布・要作り直し（{repairTargets.length}）</GroupLabel>
              <ul className="flex flex-col">
                {repairTargets.map((status) => (
                  <RepairRow key={status.fullName} status={status} running={isRepairRunning} />
                ))}
              </ul>
            </>
          )}

          {repairPending.length > 0 && (
            <>
              <GroupLabel>配布PRの確認待ち（{repairPending.length}）</GroupLabel>
              <ul className="flex flex-col">
                {repairPending.map((status) => (
                  <RepairRow key={status.fullName} status={status} running={false} />
                ))}
              </ul>
            </>
          )}

          {repairTargets.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 w-full"
              onClick={() => void handleRepairPropagate()}
              disabled={isRepairDispatching || isRunning}
            >
              {isRepairDispatching || isRepairRunning ? <Loader2 className="animate-spin" /> : <Wrench />}
              {isRepairRunning
                ? "配布を実行中..."
                : `${repairTargets.length}件へ不足・破損しているワークフローを配る`}
            </Button>
          )}

          {isRepairRunning && repairRun && (
            <p className="text-xs text-muted-foreground">
              各リポジトリへPRを作成しています。{" "}
              <a
                className="inline-flex items-center gap-0.5 underline underline-offset-2"
                href={repairRun.htmlUrl}
                target="_blank"
                rel="noreferrer"
              >
                実行を見る
                <ExternalLink className="size-3" />
              </a>
            </p>
          )}

          {repairMessage && <p className="text-xs text-muted-foreground">{repairMessage}</p>}

          <p className="text-xs text-muted-foreground">
            画面の「コンフリクトを自動解消」「CI失敗を自動修正」は各リポジトリのワークフローを
            起動します。<strong>置かれていないリポジトリでは押しても起動しません。</strong>
            配布は各リポジトリへPRを作る形で行い、
            <strong>自動マージはしません</strong>（内容を確認してマージしてください）。
          </p>
        </div>
      )}

      {(sharedFileTargets.length > 0 || sharedFilePending.length > 0) && (
        <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
          <span className="text-sm font-medium">共有スクリプト</span>

          {sharedFileError && <p className="text-sm text-destructive">{sharedFileError}</p>}

          {sharedFileTargets.length > 0 && (
            <>
              <GroupLabel>未更新（{sharedFileTargets.length}）</GroupLabel>
              <ul className="flex flex-col">
                {sharedFileTargets.map((status) => (
                  <SharedFileRow
                    key={status.fullName}
                    status={status}
                    running={isSharedFileRunning}
                  />
                ))}
              </ul>
            </>
          )}

          {sharedFilePending.length > 0 && (
            <>
              <GroupLabel>更新PRの確認待ち（{sharedFilePending.length}）</GroupLabel>
              <ul className="flex flex-col">
                {sharedFilePending.map((status) => (
                  <SharedFileRow key={status.fullName} status={status} running={false} />
                ))}
              </ul>
            </>
          )}

          {sharedFileTargets.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 w-full"
              onClick={() => void handleSharedFilePropagate()}
              disabled={isSharedFileDispatching || isRunning}
            >
              {isSharedFileDispatching || isSharedFileRunning ? (
                <Loader2 className="animate-spin" />
              ) : (
                <FileCode2 />
              )}
              {isSharedFileRunning
                ? "更新を実行中..."
                : `${sharedFileTargets.length}件の共有スクリプトを更新する`}
            </Button>
          )}

          {isSharedFileRunning && sharedFileRun && (
            <p className="text-xs text-muted-foreground">
              各リポジトリへPRを作成しています。{" "}
              <a
                className="inline-flex items-center gap-0.5 underline underline-offset-2"
                href={sharedFileRun.htmlUrl}
                target="_blank"
                rel="noreferrer"
              >
                実行を見る
                <ExternalLink className="size-3" />
              </a>
            </p>
          )}

          {sharedFileMessage && <p className="text-xs text-muted-foreground">{sharedFileMessage}</p>}

          <p className="text-xs text-muted-foreground">
            <code>.github/scripts/</code>へコピーして使っているスクリプトです。
            <strong>コピー運用のため、issue-deck側を直しても自動では行き渡りません。</strong>
            更新は各リポジトリへPRを作る形で行い、<strong>自動マージはしません</strong>
            （中身をそのまま上書きするため、
            <strong>配布先のコピーにしか無い記述は消えます</strong>
            。消える記述はPR本文に書き出されます）。
          </p>
        </div>
      )}

      <Collapsible>
        <CollapsibleTrigger className="mt-1 border-t pt-1.5 text-left text-xs text-muted-foreground hover:underline">
          この操作について
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="mt-1 text-xs text-muted-foreground">
            各リポジトリの<code>.github/workflows/</code>が参照しているタグです。issue-deck側の改善は、
            参照タグを上げるまで反映されません。<strong>uses と prompts-ref が食い違うと、新しい
            ワークフローで古いプロンプトが使われます。</strong>
            更新は各リポジトリへPRを作る形で行います。<strong>自動マージを外すと、PRの作成までで
            止まります</strong>（その場合は各リポジトリでPRを確認してマージしてください）。
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
