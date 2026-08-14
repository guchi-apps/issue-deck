"use client";

import { Check, ClipboardCopy, Cloud, Server, Terminal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useProgressStatusMutation } from "@/hooks/use-progress-status-mutation";
import {
  describeDispatchEnqueueRejection,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  resolveDefaultDispatchHost,
  resolveDispatchTargetRejection,
  type DispatchEnqueueRejection,
  type DispatchHostView,
} from "@/lib/dispatch/dispatch-job";
import { labelNamesWithLocal } from "@/lib/github/project-status-dispatch";
import { buildImplementationPrompt } from "@/lib/prompts/build-implementation-prompt";
import {
  START_IMPLEMENTATION_DEFAULT_OPTIONS,
  START_IMPLEMENTATION_OPTIONS,
  startImplementationCommentBody,
  startImplementationLabelsToAdd,
  startImplementationOptionsFromLabels,
  type StartImplementationOptionKey,
} from "@/lib/github/start-implementation";
import { cn } from "@/lib/utils";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * 実行先（#1263）。**起動する2つと、貼り付けるための2つがある。**
 *
 * 「このPC」（`issuedeck://`）を廃止したので、手元で作業する場合の出口はコピーになる。
 * 起動と同じ場所に並べるのは、**利用者にとってはどれも「このIssueの実装をどこで始めるか」の
 * 選択で、オプション（21〜24）の選び方も共通**のため。
 */
export type StartTarget =
  | { kind: "host"; host: string }
  | { kind: "actions" }
  | { kind: "copy-prompt" }
  | { kind: "copy-command" };

type StartImplementationDialogProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
  onCommentCreated: (comment: IssueComment) => void;
  /** トリガーボタンを自前で描画したい場合に指定する（Issue詳細画面での利用を想定） */
  renderTrigger?: (isSubmitting: boolean) => ReactNode;
  /** 呼び出し側で開閉状態を制御したい場合に指定する（Issue作成画面での利用を想定） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * 実行先（GitHub Actions / サブPC）も選ばせるか（#1248・既定は選ばせない）。
   *
   * **スマホのIssue詳細で`true`にする。** PCではツールバーに「実装を開始」と
   * 「ローカルで開始」が並んでいるので選択の必要が無いが、スマホのヘッダーには
   * このボタン（▶）しか置けず、サブPCで起動したい場合に本文の奥までスクロールして
   * 別のボタンを探すことになっていた。
   *
   * **申告しているホストが無ければ、`true`でも選択欄自体を出さない**（選択肢が
   * GitHub Actionsだけになるため）。
   */
  includeDispatchTargets?: boolean;
  /**
   * 親が既に取得しているディスパッチ状態（#1262）。渡すとこのダイアログは自前で取得しない。
   * **同じ画面に取得口を増やさないため**、Issue詳細では親で1回だけ取得して配る。
   */
  dispatch?: DispatchStateHandle;
  /**
   * GitHub Actionsを実行先として選べない理由（`claude-issue-dispatch.yml`が無い等・#976）。
   *
   * **トリガーボタンごと無効化してはいけない**（#1262）。実行先の選択がこのダイアログの中に
   * ある以上、押せないとサブPCでの起動まで塞がる。ここへ渡してActionsの選択肢だけを落とす。
   */
  actionsDisabledReason?: string | null;
  /** 「実装プロンプトをコピー」に載せるコメント。省略時はコメントなしとして組み立てる */
  comments?: readonly IssueComment[];
  /**
   * 「ローカル起動コマンドをコピー」で渡すコマンド（`buildLocalSessionCommand`の結果）。
   * `null`・省略ならその選択肢を出さない（ローカル起動プロトコルに適合していないリポジトリ・#1073）。
   */
  localSessionCommand?: string | null;
};

/**
 * 「実装を開始」ボタン押下時に、計画・開発環境起動・スクリーンショットの要否を
 * 選択させるダイアログ。選択されたオプションに対応するラベルを付与したうえで、
 * 実装エージェントを起動する。
 *
 * `renderTrigger`を渡すと自前のトリガーボタンから開閉する（Issue詳細画面）。
 * `open`/`onOpenChange`を渡すと呼び出し側が開閉状態を制御できる（Issue作成画面、
 * Issue作成直後に自動で開く用途）。
 *
 * `includeDispatchTargets`を渡すと**実行先も選べる**（#1248）。起動のさせ方は経路で違う。
 *
 * | 実行先 | 起動のさせ方 | 進捗（Project Status） |
 * |---|---|---|
 * | GitHub Actions | `@claude`の定型コメントを投稿する | このダイアログが報告する |
 * | サブPC | ジョブをキューに積む（`11.local`も付ける） | 起動したランチャーが報告する（#1236） |
 *
 * **サブPCを選んだときは`@claude`コメントを投稿しない。** 無人実行と同じ入口を踏ませると、
 * `11.local`が付くまでの隙間で二重起動になりうるうえ、Issueに「実装を開始してください」と
 * 残るのに動くのはサブPC、という食い違いが生まれる。
 */
export function StartImplementationDialog({
  issue,
  onIssueUpdated,
  onCommentCreated,
  renderTrigger,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  includeDispatchTargets,
  dispatch: injectedDispatch,
  actionsDisabledReason = null,
  comments = [],
  localSessionCommand = null,
}: StartImplementationDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const [options, setOptions] = useState(START_IMPLEMENTATION_DEFAULT_OPTIONS);
  /**
   * 選んだ実行先。`undefined`は**まだ選んでいない**（既定に従う）。
   *
   * 既定を実体で持たないのは、**開いた時点ではホストの一覧がまだ届いていない**ことがあるため。
   * 「未選択」を別の値にしておけば、届いた時点で既定がサブPCへ寄る（#1262）。
   */
  const [target, setTarget] = useState<StartTarget | undefined>(undefined);
  /** コピーした直後だけ文言を変え、押したことが分かるようにする */
  const [copied, setCopied] = useState(false);
  const { updateIssue, isSubmitting: isUpdatingIssue, error: labelMutationError } = useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentMutationError,
  } = useIssueCommentMutations();
  const { setProgressStatus } = useProgressStatusMutation();
  // 開いている間だけ取得する。閉じているダイアログのためにポーリングを増やさない。
  // 親から渡されている場合はそちらを使い、自前の取得は止める（#1262）
  const ownDispatch = useDispatchState(
    injectedDispatch === undefined && includeDispatchTargets === true && open,
  );
  const dispatch = injectedDispatch ?? ownDispatch;
  const isSubmitting = isUpdatingIssue || isCreatingComment || dispatch.isSubmitting;
  const error = labelMutationError ?? commentMutationError ?? dispatch.error;
  // 開いている間にissue（ポーリングによる更新等）が差し替わっても選択中のオプションを
  // 巻き戻さないよう、下のuseEffectの依存配列には含めずrefで最新値だけ参照する。
  const issueLabelsRef = useRef(issue.labels);
  useEffect(() => {
    issueLabelsRef.current = issue.labels;
  });

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびに、issueの最新ラベルを元に選択状態を同期する。openプロパティが
    // 呼び出し側から直接trueにされるケース（Issue作成直後の自動オープン）ではhandleOpenChange
    // を経由しないため、この効果で同期する。open自体の変化にのみ紐づく一度きりの処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    setOptions(startImplementationOptionsFromLabels(issueLabelsRef.current));
    // 実行先は前回の選択を持ち越さない。未選択に戻し、既定（サブPC）から選び直させる
    setTarget(undefined);
    setCopied(false);
  }, [open]);

  const job = findDispatchJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveJob = job !== null && isActiveDispatchJobStatus(job.status);
  // 「このPC」を廃止して手元の出口がコピーになったため（#1263）、申告しているホストが無くても
  // 選択欄を出す。選択肢がGitHub Actions1つだけになることはもう無い
  const showTargets = includeDispatchTargets === true;
  /**
   * 既定の実行先（#1262）。**サブPCが既定で、GitHub Actionsはフォールバック。**
   * 選べないホスト（応答していない・そのリポジトリを実行できない・未完了ジョブがある）は飛ばす。
   */
  const defaultTargetHost = showTargets
    ? resolveDefaultDispatchHost({
        hosts: dispatch.hosts,
        repositoryFullName: issue.repositoryFullName,
        hasActiveJob,
      })
    : null;
  const defaultTarget: StartTarget = defaultTargetHost
    ? { kind: "host", host: defaultTargetHost }
    : { kind: "actions" };
  const effectiveTarget = target ?? defaultTarget;
  const isCopyTarget = effectiveTarget.kind === "copy-prompt" || effectiveTarget.kind === "copy-command";

  const selectedHost =
    effectiveTarget.kind === "host"
      ? (dispatch.hosts.find((host) => host.name === effectiveTarget.host) ?? null)
      : null;
  const selectedRejection: DispatchEnqueueRejection | null =
    effectiveTarget.kind === "host"
      ? resolveDispatchTargetRejection({
          host: selectedHost,
          repositoryFullName: issue.repositoryFullName,
          hasActiveJob,
        })
      : null;
  // GitHub Actionsを選んでいて、そもそも起動しないリポジトリの場合（#976）。
  // **トリガーではなくここで止める**（#1262）
  const blockedReason = effectiveTarget.kind === "actions" ? actionsDisabledReason : null;

  function handleOpenChange(nextOpen: boolean) {
    if (onOpenChangeProp) {
      onOpenChangeProp(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  }

  function toggleOption(key: StartImplementationOptionKey) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  /**
   * 選択されたオプションに対応するラベルを付ける。**どちらの実行先でも先に行う**
   * （`21.plan-required`等はサブPCのランチャーも読むため、起動前に付いている必要がある）。
   * 付けるものが無ければ何もせず、そのままのissueを返す。失敗時は`null`。
   */
  async function applyOptionLabels(): Promise<Issue | null> {
    const labelsToAdd = startImplementationLabelsToAdd(options);
    if (labelsToAdd.length === 0) return issue;

    const currentNames = issue.labels.map((label) => label.name);
    const nextNames = [...new Set([...currentNames, ...labelsToAdd])];
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: nextNames,
    });
    if (!updated) return null;
    onIssueUpdated(updated);
    return updated;
  }

  /** GitHub Actionsの無人実行を起動する（従来の経路） */
  async function startOnActions(currentIssue: Issue) {
    // カンバンを即座に追従させる（#991 Phase 3）。オプションラベル→Statusの順に書くのは、
    // 万一この書き込みがWebhook起動の判定に届いた場合でも「計画が必要」の選択が先に反映される
    // ようにするため（通常はissue-deck自身の書き込みとして無視される）。失敗しても続行する。
    await setProgressStatus({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      status: options.planRequired ? "planning" : "implementation",
    });

    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: startImplementationCommentBody(options.planRequired),
    });
    if (!created) return;

    onCommentCreated(created);
    onIssueUpdated({ ...currentIssue, commentCount: currentIssue.commentCount + 1 });
    handleOpenChange(false);
  }

  /**
   * サブPCへジョブを積む（#1179）。**進捗の報告はここでは行わない。**
   * 起動したランチャーが`11.local`の付与と合わせて報告する（#1096・#1236）。
   */
  async function startOnHost(currentIssue: Issue, hostName: string) {
    const enqueued = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName,
    });
    // 拒否された理由は`dispatch.error`に入る。ダイアログは閉じない（選び直せるように）
    if (!enqueued) return;

    // `11.local`は**積めたときだけ**付ける。拒否されたのにラベルだけ残ると、
    // 無人実行（claude-issue-dispatch.yml）までそのIssueに触れなくなる。
    // 付与に失敗しても起動自体は妨げない（起動できないより、ラベルが遅れる方が軽い）。
    const nextNames = labelNamesWithLocal(currentIssue.labels);
    if (nextNames) {
      const updated = await updateIssue({
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        labels: nextNames,
      });
      if (updated) onIssueUpdated(updated);
    }
    handleOpenChange(false);
  }

  /**
   * 手元のセッションへ貼るための文面をクリップボードへ渡す（#1263）。
   *
   * **`11.local`の付与と進捗の報告はここで行う。** 貼り付け先のセッションを起動するのは人間で、
   * ランチャーを通らないため、これをやらないと無人実行と二重に走りうるうえ盤面も動かない。
   * 起動コマンドのコピーでは行わない（そちらは`start-local-session.sh`が同じことをする）。
   */
  async function copyForLocalSession(currentIssue: Issue, kind: "copy-prompt" | "copy-command") {
    const text =
      kind === "copy-command"
        ? localSessionCommand
        : buildImplementationPrompt({
            repositoryFullName: issue.repositoryFullName,
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body,
            labels: currentIssue.labels,
            comments,
          });
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードが使えない環境（権限拒否・非セキュアコンテキスト）では、ラベルや進捗を
      // 動かさずに終える。コピーできていないのに着手済みの状態になる方が困る
      return;
    }
    setCopied(true);

    if (kind === "copy-prompt") {
      const nextNames = labelNamesWithLocal(currentIssue.labels);
      if (nextNames) {
        const updated = await updateIssue({
          repositoryFullName: issue.repositoryFullName,
          number: issue.number,
          labels: nextNames,
        });
        if (updated) onIssueUpdated(updated);
      }
      await setProgressStatus({
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        status: options.planRequired ? "planning" : "implementation",
      });
    }
  }

  async function handleStart() {
    const currentIssue = await applyOptionLabels();
    if (!currentIssue) return;

    if (effectiveTarget.kind === "host") {
      await startOnHost(currentIssue, effectiveTarget.host);
      return;
    }
    if (effectiveTarget.kind === "copy-prompt" || effectiveTarget.kind === "copy-command") {
      await copyForLocalSession(currentIssue, effectiveTarget.kind);
      return;
    }
    await startOnActions(currentIssue);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {renderTrigger && <DialogTrigger asChild>{renderTrigger(isSubmitting)}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>実装を開始</DialogTitle>
          <DialogDescription>必要なオプションを選択してから実装を開始してください。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {START_IMPLEMENTATION_OPTIONS.map((option) => (
            <div key={option.key} className="flex items-start gap-2">
              <Checkbox
                id={`start-implementation-${option.key}`}
                checked={options[option.key]}
                onCheckedChange={() => toggleOption(option.key)}
                className="mt-0.5"
              />
              <Label htmlFor={`start-implementation-${option.key}`} className="flex-col items-start gap-0.5">
                {option.label}
                <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
              </Label>
            </div>
          ))}
        </div>
        {showTargets && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">実行先</p>
            {dispatch.hosts.map((host) => (
              <DispatchHostOption
                key={host.name}
                host={host}
                repositoryFullName={issue.repositoryFullName}
                hasActiveJob={hasActiveJob}
                selected={effectiveTarget.kind === "host" && effectiveTarget.host === host.name}
                onSelect={() => setTarget({ kind: "host", host: host.name })}
              />
            ))}
            <StartTargetOption
              icon={<Cloud className="size-3.5" />}
              name="GitHub Actions"
              description={
                actionsDisabledReason ??
                "無人実行のワークフローを起動します（サブPCが使えないときのフォールバック）"
              }
              selected={effectiveTarget.kind === "actions"}
              disabled={actionsDisabledReason !== null}
              onSelect={() => setTarget({ kind: "actions" })}
            />
            {/* 手元で作業する場合の出口。「このPC」（issuedeck://）の置き換え（#1263） */}
            <StartTargetOption
              icon={<ClipboardCopy className="size-3.5" />}
              name="実装プロンプトをコピー"
              description="開いているClaude Codeセッションへ貼ります。11.localの付与と進捗の報告も行います"
              selected={effectiveTarget.kind === "copy-prompt"}
              onSelect={() => setTarget({ kind: "copy-prompt" })}
            />
            {localSessionCommand && (
              <StartTargetOption
                icon={<Terminal className="size-3.5" />}
                name="起動コマンドをコピー"
                description="ターミナルへ貼ると、worktreeの作成から新しいセッションの起動までを行います"
                selected={effectiveTarget.kind === "copy-command"}
                onSelect={() => setTarget({ kind: "copy-command" })}
              />
            )}
          </div>
        )}
        <ApiErrorMessage message={error} />
        {/* 実行先の一覧を出しているときは、理由はGitHub Actionsの選択肢の説明として既に見えている。
            一覧を出さない呼び出し（Issue作成直後の自動オープン等）でだけ、ここに出す */}
        {blockedReason && !showTargets && (
          <p className="text-sm text-destructive">{blockedReason}</p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              キャンセル
            </Button>
          </DialogClose>
          <Button
            onClick={handleStart}
            disabled={isSubmitting || selectedRejection !== null || blockedReason !== null}
          >
            {isCopyTarget ? (copied ? "コピーしました" : "コピーする") : "開始する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 起動先1件ぶんの選択肢。**選べない場合は理由を添えて押せなくする**（#1180と同じ扱い）。
 * 理由の判定と文言はAPI側（`enqueueDispatchJob`）と同じものを使う。
 */
function DispatchHostOption({
  host,
  repositoryFullName,
  hasActiveJob,
  selected,
  onSelect,
}: {
  host: DispatchHostView;
  repositoryFullName: string;
  hasActiveJob: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const rejection = resolveDispatchTargetRejection({ host, repositoryFullName, hasActiveJob });
  const description = rejection
    ? describeDispatchEnqueueRejection(rejection, { hostName: host.name, repositoryFullName })
    : `ジョブを積みます。${host.name}が取りに来た時点で起動します`;

  return (
    <StartTargetOption
      icon={<Server className="size-3.5" />}
      name={host.name}
      description={description}
      selected={selected}
      disabled={rejection !== null}
      onSelect={onSelect}
    />
  );
}

/** 実行先の選択肢1件。スマホで押しやすいよう行全体を押せるようにする */
function StartTargetOption({
  icon,
  name,
  description,
  selected,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left",
        selected ? "border-primary bg-accent" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {name}
        {selected && <Check className="size-3.5 text-primary" />}
      </span>
      <span className="text-xs font-normal text-muted-foreground">{description}</span>
    </button>
  );
}
