"use client";

import {
  Camera,
  Check,
  ClipboardCopy,
  ClipboardList,
  Cloud,
  GitMerge,
  MonitorPlay,
  Palette,
  Server,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useProgressStatusMutation } from "@/hooks/use-progress-status-mutation";
import {
  describeDispatchEnqueueRejection,
  findBlockingSession,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  resolveDefaultDispatchHost,
  resolveDispatchTargetRejection,
  resolveScreenshotRejection,
  type DispatchEnqueueRejection,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { labelNamesWithLocal } from "@/lib/github/project-status-dispatch";
import { buildImplementationPrompt } from "@/lib/prompts/build-implementation-prompt";
import {
  ARTIFACT_REQUIRED_LABEL,
  artifactRequiredDefaultForLabels,
  START_IMPLEMENTATION_DEFAULT_OPTIONS,
  startImplementationCommentBody,
  startImplementationLabelsToAdd,
  startImplementationOptionsFromLabels,
  visibleStartImplementationOptions,
  type StartImplementationOptionKey,
} from "@/lib/github/start-implementation";
import { cn } from "@/lib/utils";
import type { Issue, IssueComment, SubIssueRelations } from "@/types/issue";

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

/** 同じ実行先を指しているか（選択中の判定に使う） */
function isSameTarget(a: StartTarget, b: StartTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "host" && b.kind === "host" ? a.host === b.host : true;
}

/**
 * 実行先1件ぶんの表示材料（#1623）。**タイルには短い名前しか出さない。**
 * 4つ横並びにすると1枚あたり80px弱（iPhone 15でダイアログが361pxのとき約78px）しかなく、
 * 「実装プロンプトをコピー」のような正式名称は入らない。正式名称は`aria-label`と`title`に持たせ、
 * 説明と選べない理由はグリッドの下に出す。
 */
type StartTargetEntry = {
  key: string;
  target: StartTarget;
  icon: LucideIcon;
  /** 正式名称（読み上げ・グリッド下の見出し） */
  name: string;
  /** タイルに出す短い名前 */
  shortName: string;
  description: string;
  /** 選べない理由。`null`なら選べる */
  rejection: string | null;
};

/**
 * オプションのアイコン（#1623）。**定義側（`start-implementation.ts`）ではなくここに置く。**
 * あちらはAPIルートなどサーバ側からも読まれるため、Reactコンポーネントへ依存させない。
 */
const OPTION_ICONS: Record<StartImplementationOptionKey, LucideIcon> = {
  planRequired: ClipboardList,
  artifactRequired: Palette,
  mergeConfirmRequired: GitMerge,
  previewRequired: MonitorPlay,
  screenshotRequired: Camera,
};

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
   * 親子Issue（#1267）。**子Issueを渡された側で親の背景が丸ごと落ちる**のを防ぐため、
   * 分かっていれば文面へ載せる。省略時は「取得していません」と出す
   */
  subIssueRelations?: SubIssueRelations;
  /**
   * 「ローカル起動コマンドをコピー」で渡すコマンド（`buildLocalSessionCommand`の結果）。
   * `null`・省略ならその選択肢を出さない（ローカル起動プロトコルに適合していないリポジトリ・#1073）。
   */
  localSessionCommand?: string | null;
};

/**
 * 「実装を開始」ボタン押下時に、計画・マージ前確認・開発環境起動・スクリーンショットの要否を
 * 選択させるダイアログ。選択されたオプションに対応するラベルを付与したうえで、
 * 実装エージェントを起動する。
 *
 * オプションは実行先で出し分ける（#1317・`visibleStartImplementationOptions`）。撮影は
 * GitHub Actionsを選んだときだけ出る。「計画が必要」の初期状態はIssueの種別ラベルから決まる。
 *
 * `renderTrigger`を渡すと自前のトリガーボタンから開閉する（Issue詳細画面）。
 * `open`/`onOpenChange`を渡すと呼び出し側が開閉状態を制御できる（Issue作成画面の
 * 「作成+実装開始」が、作成直後にこのダイアログを開く用途・#1323）。**オプションを選ばせるのは
 * どの経路でもこのダイアログだけ**で、作成画面には出さない（#1580）。
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
  subIssueRelations,
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
  /**
   * このダイアログから起動した実行先（#1318）。**押してから閉じ切るまでの間だけ入る。**
   *
   * 押した結果で選択欄が書き変わらないようにするために持つ。サブPCへ積んだ直後は、
   * 自分が積んだジョブのせいでそのホストが`already_queued`で塞がり、既定の実行先が
   * GitHub Actionsへ移る。閉じるまでの一瞬でも「サブPCの選択肢が消えてGitHub Actionsが
   * 既定として光った開始画面」が見えてしまい、どちらで起動したのか分からなくなる。
   */
  const [startedTarget, setStartedTarget] = useState<StartTarget | null>(null);
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
  /**
   * そのリポジトリに**定義されている**ラベル名（#1956）。アーティファクトの既定を当ててよいかの
   * 判定にだけ使う。開いている間だけ取りに行く（閉じているダイアログのために取得を増やさない）。
   */
  const { labels: repositoryLabels } = useIssueRepoMeta(open ? issue.repositoryFullName : null);
  const repositoryLabelNames = repositoryLabels.map((label) => label.name);
  const hasArtifactLabelDefinition = repositoryLabelNames.includes(ARTIFACT_REQUIRED_LABEL);
  const isSubmitting = isUpdatingIssue || isCreatingComment || dispatch.isSubmitting;
  const error = labelMutationError ?? commentMutationError ?? dispatch.error;
  // 開いている間にissue（ポーリングによる更新等）が差し替わっても選択中のオプションを
  // 巻き戻さないよう、下のuseEffectの依存配列には含めずrefで最新値だけ参照する。
  const issueLabelsRef = useRef(issue.labels);
  // リポジトリのラベル一覧も同じ理由でrefから読む（届くたびに選択状態を巻き戻さないため・#1956）
  const repositoryLabelNamesRef = useRef(repositoryLabelNames);
  useEffect(() => {
    issueLabelsRef.current = issue.labels;
    repositoryLabelNamesRef.current = repositoryLabelNames;
  });

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびに、issueの最新ラベルを元に選択状態を同期する。openプロパティが
    // 呼び出し側から直接trueにされるケース（Issue作成直後の自動オープン）ではhandleOpenChange
    // を経由しないため、この効果で同期する。open自体の変化にのみ紐づく一度きりの処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    setOptions(startImplementationOptionsFromLabels(issueLabelsRef.current, repositoryLabelNamesRef.current));
    // 実行先は前回の選択を持ち越さない。未選択に戻し、既定（サブPC）から選び直させる
    setTarget(undefined);
    setStartedTarget(null);
    setCopied(false);
  }, [open]);

  /**
   * リポジトリのラベル一覧は非同期で届くため、開いた直後の同期では間に合わないことがある（#1956）。
   * 届いた時点でアーティファクトの既定をもう一度当てる。
   *
   * **既定はOFF→ONの一方向にしか動かさない**ので、先にユーザーが押した選択を打ち消すことはない
   * （初期値がOFFである以上、この間にユーザーができるのはONにする操作だけ）。上の同期のように
   * `setOptions`ごと置き換えると、他のチップの選択まで巻き戻る。
   */
  useEffect(() => {
    if (!open) return;
    const shouldTurnOn = artifactRequiredDefaultForLabels({
      issueLabelNames: issueLabelsRef.current.map((label) => label.name),
      repositoryLabelNames: repositoryLabelNamesRef.current,
    });
    if (!shouldTurnOn) return;
    setOptions((prev) => (prev.artifactRequired ? prev : { ...prev, artifactRequired: true }));
  }, [open, hasArtifactLabelDefinition]);

  const job = findDispatchJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveJob = job !== null && isActiveDispatchJobStatus(job.status);
  // 起動済み（セッション生存中）のIssueは積ませない（#1311）
  const blockingSession = findBlockingSession({
    sessions: dispatch.sessions,
    hosts: dispatch.hosts,
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
  });
  // 「このPC」を廃止して手元の出口がコピーになったため（#1263）、申告しているホストが無くても
  // 選択欄を出す。選択肢がGitHub Actions1つだけになることはもう無い
  const showTargets = includeDispatchTargets === true;
  /**
   * 実行先がまだ確定していないか（#1666）。**確定するまで選択肢を1つも出さない。**
   *
   * ホストの一覧は`GET /api/dispatch`が返るまで空で、そのまま組み立てると「サブPCが無い
   * 選択欄（既定はGitHub Actions）」を先に描いてから、届いた時点でサブPCを足して既定も
   * 移すことになる。実行先で出るオプションまで変わる（撮影⇄アーティファクト）ため、
   * 押そうとしていたものが指の下で別物に入れ替わる。
   *
   * 一覧が空のまま確定した場合（申告しているサブPCが無い・取得に失敗した）は通常どおり出す。
   * 待たせるのは「まだ分からない」間だけで、「無いと分かった」後ではない。
   */
  const isTargetPending = showTargets && !dispatch.isLoaded;
  /**
   * 未完了ジョブを理由に選択肢を塞ぐか（#1318）。**このダイアログから積んだ直後は塞がない。**
   *
   * 自分が押した結果で自分の選択肢が消えても、利用者には何の情報にもならない。閉じ切るまでの
   * 間だけの話で、開き直せば通常どおり「実行中または待機中のジョブが既にあります」として塞がる。
   */
  const blocksByActiveJob = hasActiveJob && startedTarget === null;
  /**
   * 既定の実行先（#1262）。**サブPCが既定で、GitHub Actionsはフォールバック。**
   * 選べないホスト（応答していない・そのリポジトリを実行できない・未完了ジョブがある・
   * 既にセッションが動いている）は飛ばす。
   */
  const defaultTargetHost = showTargets
    ? resolveDefaultDispatchHost({
        hosts: dispatch.hosts,
        repositoryFullName: issue.repositoryFullName,
        hasActiveJob: blocksByActiveJob,
        blockingSession,
      })
    : null;
  const defaultTarget: StartTarget = defaultTargetHost
    ? { kind: "host", host: defaultTargetHost }
    : { kind: "actions" };
  // 押した実行先を最優先にする。ホストの一覧が遅れて届いても、積んだジョブで既定が動いても、
  // 押した後の表示が別の実行先へ移らない（#1318）
  const effectiveTarget = startedTarget ?? target ?? defaultTarget;
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
          hasActiveJob: blocksByActiveJob,
          blockingSession,
        })
      : null;
  // GitHub Actionsを選んでいて、そもそも起動しないリポジトリの場合（#976）。
  // **トリガーではなくここで止める**（#1262）
  const blockedReason = effectiveTarget.kind === "actions" ? actionsDisabledReason : null;
  // 選んだホストでスクリーンショットを撮れない場合（#1268）。**申告していないホストは塞がない**
  const screenshotRejection = resolveScreenshotRejection(selectedHost);
  // 実行先で出し分けたオプション（#1317）。撮影はGitHub Actionsのときだけ出す
  const visibleOptions = visibleStartImplementationOptions({
    isActionsTarget: effectiveTarget.kind === "actions",
    options,
  });

  /**
   * 実行先のタイル（#1623）。**選べない理由の判定と文言は従来どおりAPI側と同じものを使う。**
   * 出す場所がタイルの中からグリッドの下へ移っただけで、内容は変えていない。
   */
  const targetEntries: StartTargetEntry[] = showTargets
    ? [
        ...dispatch.hosts.map((host): StartTargetEntry => {
          const rejection = resolveDispatchTargetRejection({
            host,
            repositoryFullName: issue.repositoryFullName,
            hasActiveJob: blocksByActiveJob,
            blockingSession,
          });
          const name = formatDispatchHostName(host.name);
          return {
            key: `host:${host.name}`,
            target: { kind: "host", host: host.name },
            icon: Server,
            name,
            shortName: name,
            description: `ジョブを積みます。${name}が取りに来た時点で起動します`,
            rejection: rejection
              ? describeDispatchEnqueueRejection(rejection, {
                  hostName: host.name,
                  repositoryFullName: issue.repositoryFullName,
                  session: blockingSession,
                })
              : null,
          };
        }),
        {
          key: "actions",
          target: { kind: "actions" },
          icon: Cloud,
          name: "GitHub Actions",
          shortName: "Actions",
          description: "無人実行のワークフローを起動します（サブPCが使えないときのフォールバック）",
          rejection: actionsDisabledReason,
        },
        // 手元で作業する場合の出口。「このPC」（issuedeck://）の置き換え（#1263）
        {
          key: "copy-prompt",
          target: { kind: "copy-prompt" },
          icon: ClipboardCopy,
          name: "実装プロンプトをコピー",
          shortName: "プロンプト",
          description: "開いているClaude Codeセッションへ貼ります。11.localの付与と進捗の報告も行います",
          rejection: null,
        },
        ...(localSessionCommand
          ? [
              {
                key: "copy-command",
                target: { kind: "copy-command" } as StartTarget,
                icon: Terminal,
                name: "起動コマンドをコピー",
                shortName: "コマンド",
                description:
                  "ターミナルへ貼ると、worktreeの作成から新しいセッションの起動までを行います",
                rejection: null,
              },
            ]
          : []),
      ]
    : [];
  const selectedEntry = targetEntries.find((entry) => isSameTarget(entry.target, effectiveTarget)) ?? null;
  const blockedEntries = targetEntries.filter((entry) => entry.rejection !== null);
  /**
   * オプションのグリッドの下に出す説明（#1623）。**ONにしたものと、選べないものだけ出す。**
   * 全部の説明を常に出すと縦に伸びてしまうため、ONにした内容の確認と、押せない理由の提示に絞る。
   */
  const optionHints = visibleOptions.flatMap((option) => {
    const unavailable = option.key === "screenshotRequired" && screenshotRejection !== null;
    if (unavailable) return [{ key: option.key, label: option.label, text: screenshotRejection }];
    if (!options[option.key]) return [];
    return [{ key: option.key, label: option.label, text: option.description }];
  });

  function handleOpenChange(nextOpen: boolean) {
    if (onOpenChangeProp) {
      onOpenChangeProp(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  }

  /**
   * 実行先を選び直す。**押した実行先のピン留めも解く**（#1318）。
   * コピーの後はダイアログが開いたまま残るため、続けて別の出口を選べる必要がある。
   */
  function selectTarget(next: StartTarget) {
    setStartedTarget(null);
    setTarget(next);
    // 直前のコピーの結果を、選び直した先の結果として見せない
    setCopied(false);
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
    // 既に全部付いているなら書き込まない。Issue作成画面から来た場合（#1323）は作成時に
    // 付与済みで毎回ここに当たるため、増えないPATCHを投げないようにする
    if (nextNames.length === currentNames.length) return issue;
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
    // 拒否された理由は`dispatch.error`に入る。ダイアログは閉じない（選び直せるように）。
    // ピン留めも解き、拒否された時点の状態で選択欄を出し直す（#1318）
    if (!enqueued) {
      setStartedTarget(null);
      return;
    }

    // **積めた時点で閉じる**（#1318）。この後の`11.local`の付与はGitHubへの往復で、
    // 開いたまま待つと、その間ずっと「もう積んである」前提の選択欄が見えることになる。
    handleOpenChange(false);

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
            relations: subIssueRelations
              ? [
                  ...(subIssueRelations.parent
                    ? [{ ...subIssueRelations.parent, relation: "parent" as const }]
                    : []),
                  ...subIssueRelations.children.map((child) => ({
                    ...child,
                    relation: "sub" as const,
                  })),
                ]
              : undefined,
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
    // 押した時点の実行先を固定する（#1318）。以降の再描画（オプションのラベル付与・
    // ジョブの追加・ポーリングでのホストの入れ替わり）で選択が動かないようにする
    setStartedTarget(effectiveTarget);

    const currentIssue = await applyOptionLabels();
    if (!currentIssue) {
      setStartedTarget(null);
      return;
    }

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
          <DialogDescription>
            実行する場所と必要なオプションを選んでから開始してください。
          </DialogDescription>
        </DialogHeader>
        {/* 実行先が確定するまでは、選択肢の代わりに骨組みだけを出す（#1666） */}
        {isTargetPending && <StartChoicesSkeleton />}
        {/* 実行先を先に選ばせる（#1623）。実行先によって出るオプションが変わる（撮影は
            GitHub Actionsのときだけ・アーティファクトはそれ以外）ため、選ぶ順序としても素直になる */}
        {showTargets && !isTargetPending && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">実行先</p>
            <div role="radiogroup" aria-label="実行先" className="grid grid-cols-4 gap-1.5">
              {targetEntries.map((entry) => (
                <StartTargetTile
                  key={entry.key}
                  entry={entry}
                  selected={isSameTarget(entry.target, effectiveTarget)}
                  onSelect={() => selectTarget(entry.target)}
                />
              ))}
            </div>
            {/* 選択中の説明。選べない実行先の理由は下でまとめて出すので、ここでは重ねない */}
            {selectedEntry && selectedEntry.rejection === null && (
              <p className="text-xs text-muted-foreground">{selectedEntry.description}</p>
            )}
            {blockedEntries.map((entry) => (
              <p key={entry.key} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{entry.name}</span>: {entry.rejection}
              </p>
            ))}
          </div>
        )}
        {/* オプションは実行先で出し分ける（#1317）ので、実行先が確定するまで出さない（#1666） */}
        {!isTargetPending && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">オプション</p>
            <div className="grid grid-cols-2 gap-2">
              {visibleOptions.map((option) => {
                // 撮れないホストで選ばせると、無人実行では依存の追加を確認する相手がいないまま
                // 止まる（#1268）。**既に付いているものは外せるよう、チェック済みなら塞がない**
                const unavailable =
                  option.key === "screenshotRequired" && screenshotRejection !== null;
                return (
                  <StartOptionChip
                    key={option.key}
                    icon={OPTION_ICONS[option.key]}
                    label={option.label}
                    description={unavailable ? (screenshotRejection ?? "") : option.description}
                    checked={options[option.key]}
                    disabled={unavailable && !options[option.key]}
                    onToggle={() => toggleOption(option.key)}
                  />
                );
              })}
            </div>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {optionHints.length > 0 ? (
                optionHints.map((hint) => (
                  <li key={hint.key}>
                    <span className="font-medium text-foreground">{hint.label}</span>: {hint.text}
                  </li>
                ))
              ) : (
                <li>オプションを押すとONになり、ここに内容が出ます。</li>
              )}
            </ul>
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
          {/* 実行先が確定するまでは押させない（#1666）。押せてしまうと、選ばせていない既定
              （ホストの一覧が空なのでGitHub Actions）で起動することになる */}
          <Button
            onClick={handleStart}
            disabled={
              isSubmitting || isTargetPending || selectedRejection !== null || blockedReason !== null
            }
          >
            {isCopyTarget ? (copied ? "コピーしました" : "コピーする") : "開始する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 実行先が確定するまでの骨組み（#1666）。**選択肢を1つも出さず、場所だけ確保する。**
 *
 * 見出しと枚数を本番と同じにしているのは、確定した瞬間にダイアログの高さが変わらないようにするため。
 * 枚数（実行先4・オプション4）は最も多い場合に合わせてあり、確定後に減ることはあっても増えない。
 */
function StartChoicesSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">実行先</p>
        <div className="grid grid-cols-4 gap-1.5">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="min-h-[68px] rounded-lg" />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">実行できる場所を確認しています…</p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">オプション</p>
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="min-h-[46px] rounded-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 実行先の選択肢1件（#1623）。**アイコンを主役にした正方形のタイルで、4つ横に並べる。**
 *
 * 読み上げ・hoverには正式名称と説明（選べない場合は理由）を残す。タイルの中に説明を置かないのは、
 * 幅が80px弱しか無く、置いても読めないため。**選べない場合に押せなくする扱いは従来どおり**
 * （#1180）で、理由の判定と文言もAPI側（`enqueueDispatchJob`）と同じものを使っている。
 */
function StartTargetTile({
  entry,
  selected,
  onSelect,
}: {
  entry: StartTargetEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = entry.icon;
  const disabled = entry.rejection !== null;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={entry.name}
      title={entry.rejection ?? entry.description}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-lg border px-1 py-2 text-center",
        selected
          ? "border-primary bg-accent text-foreground ring-1 ring-primary"
          : "text-muted-foreground hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Icon className="size-5" />
      <span className="text-[10px] leading-tight font-medium">{entry.shortName}</span>
    </button>
  );
}

/**
 * オプション1件（#1623）。**アイコンとラベルを横に並べた行型のチップ。**
 *
 * 実行先（アイコン中心・中央揃え）とわざと形を変えている。同じ見た目のグリッドが上下に続くと、
 * 「どちらが実行先でどちらがオプションか」が一目で分からなくなるため。説明は`title`と
 * グリッド下のリストに出す。
 */
function StartOptionChip({
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={description}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-h-[46px] items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-left",
        checked ? "border-primary bg-accent" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Icon className={cn("size-4 shrink-0", checked ? "text-foreground" : "text-muted-foreground")} />
      <span className="text-[11px] font-medium leading-tight">{label}</span>
      {/* 押しても幅が動かないよう、OFFのときも場所だけ確保する */}
      <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !checked && "invisible")} />
    </button>
  );
}
