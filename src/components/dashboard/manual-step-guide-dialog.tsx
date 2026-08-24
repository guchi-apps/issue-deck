"use client";

import {
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleStop,
  Flag,
  FolderOpen,
  GitBranch,
  Hand,
  Info,
  Loader2,
  MonitorSmartphone,
  PartyPopper,
  TriangleAlert,
  Undo2,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { ManualStepAutoRunPanel } from "@/components/dashboard/manual-step-autorun-panel";
import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import { ManualStepRunPanel } from "@/components/dashboard/manual-step-run-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueTaskList } from "@/hooks/use-issue-task-list";
import {
  useManualStepAutoRun,
  type ManualStepAutoRunHandle,
} from "@/hooks/use-manual-step-autorun";
import { useManualStepPrerequisites } from "@/hooks/use-manual-step-prerequisites";
import { resolveManualStepCloseWarning } from "@/lib/manual-step-close-warning";
import {
  describeManualStepAbortRejection,
  describeManualStepExecutionRejection,
  resolveManualStepAbortRejection,
  resolveManualStepHost,
  type DispatchHostView,
  type ManualStepExecutionRejection,
} from "@/lib/dispatch/dispatch-job";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  buildManualStepRunPlan,
  findManualStepEntry,
  type ManualStepRunEntry,
  type ManualStepRunPlan,
} from "@/lib/manual-step-autorun";
import {
  MANUAL_STEP_TIMEOUT_SECONDS,
  replaceManualStepCommand,
} from "@/lib/manual-step-command";
import {
  describeManualStepRun,
  isActiveManualStepRun,
  manualStepRunProgressPercent,
  type ManualStepRunView,
} from "@/lib/manual-step-run-view";
import {
  parseManualStepGuide,
  resolveManualStepDevice,
  type ManualStepGuide,
  type ManualStepGuideStep,
} from "@/lib/manual-step-guide";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

/**
 * 手作業アシスタント（#1826）。溜まった手作業Issueを、1手順ずつ順番に案内する。
 *
 * 手作業Issueの本文はテンプレートで並びが決まっている（`lib/manual-step-guide.ts`）のに、
 * 実行する人は「一覧を開く → Issueを開く → 本文を上から読み直して、実行する場所と
 * コマンドを自分で拾う」を件数ぶん繰り返していた。ここでは本文を
 * 「目的 → 手順1..n → 完了の確認」へ割り、**実行する場所（デバイス・ディレクトリ・ブランチ）を
 * どのステップでも同じ位置に出したまま**1手順ずつ出す。
 *
 * **PC・スマホで同じコンポーネントを使う**（`manual-step-panel.tsx`と同じ方針）。
 * 片方だけに手を入れると、同じ手作業の案内が画面ごとに食い違う。スマホ幅では全画面にし、
 * 押すボタンを下端へ固定する。
 *
 * 新しい状態も新しいAPIも持たない。チェックの実体はIssue本文で
 * （`hooks/use-issue-task-list.ts`）、クローズは`ManualStepPanel`と同じ`PATCH /api/issues`。
 * GitHubで付けても画面で付けてもここで付けても、同じ1か所が書き換わる。
 */

/** アシスタントが出す1画面 */
type GuideStage =
  /** この作業の目的・前提条件の状況 */
  | { kind: "overview" }
  /** `## やること`の1手順 */
  | { kind: "step"; step: ManualStepGuideStep; order: number }
  /** テンプレートに沿っていない本文。手順に割れないので本文をそのまま出す */
  | { kind: "body" }
  /** `## 完了の確認方法`とクローズの出口 */
  | { kind: "finish" };

function buildStages(guide: ManualStepGuide): GuideStage[] {
  const middle: GuideStage[] = guide.hasTemplate
    ? guide.steps.map((step, order) => ({ kind: "step" as const, step, order }))
    : [{ kind: "body" as const }];
  return [{ kind: "overview" }, ...middle, { kind: "finish" }];
}

/**
 * 進捗レールの1段に出す印（#2194）。**担い手は実行計画の`rejection`をそのまま読む**——
 * ここで「サブPCならtrue」のような条件を書き直すと、承認パネルに並ぶ「代行できる／あなたが実行」と
 * レールの印が食い違う（判定の正は`lib/dispatch/dispatch-job.ts`の
 * `resolveManualStepExecutionRejection`ひとつ）。
 *
 * ただし**`rejection`を「あなたが実行」へ畳まない**。`rejection`は「そもそも代行の対象外」と
 * 「ホストの都合でいまは押せない」を1つの値にまとめており、pollerが止まっている間に畳むと、
 * 本当はサブPCが実行する手順まで「人がやるもの」として並ぶ（レールは常時見えているので、
 * 理由を読まずに手で実行しに行くことになる）。前者だけを`manual`、後者は`pending`にする。
 */
type StageMark = {
  tone: "neutral" | "auto" | "pending" | "manual" | "done";
  Icon: LucideIcon;
  /** ツールチップ・読み上げに出す担い手の説明（手順の見出しのバッジにもそのまま出す） */
  label: string;
  /** 代行できない理由（`title`・読み上げに足す）。ドットには理由文を書く場所が無いため */
  reason: string | null;
};

/**
 * **ホストの都合で「いまは」代行できない理由**（更新すれば押せるようになる）。
 * これ以外は手順そのものの性質で、押せるようになる見込みが無い
 * （`resolveManualStepExecutionRejection`のコメントと同じ切り分け）。
 */
const HOST_SIDE_REJECTIONS = new Set<ManualStepExecutionRejection>([
  "host_unknown",
  "host_offline",
  "manual_step_unsupported",
  "already_queued",
]);

const STAGE_MARK_TONE: Record<StageMark["tone"], string> = {
  neutral: "border-border bg-background text-muted-foreground",
  auto: "border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-300",
  pending: "border-dashed border-border bg-muted text-muted-foreground",
  manual: "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  done: "border-transparent bg-emerald-500 text-white",
};

/** いま開いている段。**担い手の色は残したまま**濃くする（現在地が分かっても担い手が分からないと困る） */
const STAGE_MARK_CURRENT_TONE: Record<StageMark["tone"], string> = {
  neutral: "border-violet-500 ring-3 ring-violet-500/20",
  auto: "border-violet-500 bg-violet-500 text-white ring-3 ring-violet-500/20",
  pending: "border-solid border-violet-500 ring-3 ring-violet-500/20",
  manual: "border-amber-500 bg-amber-500 text-white ring-3 ring-amber-500/20",
  done: "ring-3 ring-emerald-500/25",
};

const STAGE_MARK_BADGE_TONE: Record<StageMark["tone"], string> = {
  neutral: "bg-muted text-muted-foreground",
  auto: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  pending: "bg-muted text-muted-foreground",
  manual: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

/**
 * 実行計画の1件から印を作る。
 *
 * **`entry`が`null`なのは実行計画に載らない手順**（`## やること`が`- [ ]`で書かれておらず、
 * 節全体が1手順になったもの。`lib/manual-step-guide.ts`が`line: null`で返す）。代行の対象
 * そのものが無いので「あなたが実行」でよい——ホストの状態とは関係なく、押せるようにはならない。
 */
function resolveEntryMark(entry: ManualStepRunEntry | null, hostName: string): StageMark {
  if (entry === null) {
    return { tone: "manual", Icon: Hand, label: "あなたが実行", reason: null };
  }
  if (entry.rejection === null) {
    return { tone: "auto", Icon: Zap, label: "代行できる", reason: null };
  }
  const reason = describeManualStepExecutionRejection(entry.rejection, {
    hostName,
    device: entry.device,
    interactiveCommand: entry.interactiveCommand,
    placeholder: entry.placeholder,
  });
  return HOST_SIDE_REJECTIONS.has(entry.rejection)
    ? { tone: "pending", Icon: Zap, label: "いまは代行できない", reason }
    : { tone: "manual", Icon: Hand, label: "あなたが実行", reason };
}

/**
 * 段の印を決める。
 *
 * **バッジが意味するのは「その手順が代行の対象か」で、いま実行中かどうかは含めない**——
 * `plan`へ`hasActiveJob`を渡していないので`already_queued`はここには出ない（渡すと、実行中の
 * あいだレールの印が「いまは代行できない」へ揺れる）。実行中かどうかは`AutoRunBar`と
 * `ManualStepRunPanel`が出す。
 */
function resolveStageMark(
  stage: GuideStage,
  plan: ManualStepRunPlan,
  hostName: string,
): StageMark {
  switch (stage.kind) {
    case "overview":
      return { tone: "neutral", Icon: Info, label: "この作業の目的", reason: null };
    case "body":
      return { tone: "neutral", Icon: Flag, label: "やること", reason: null };
    case "step": {
      if (stage.step.checked) {
        return { tone: "done", Icon: Check, label: "実行済み", reason: null };
      }
      const entry =
        stage.step.line === null ? null : findManualStepEntry(plan, stage.step.line);
      return resolveEntryMark(entry, hostName);
    }
    case "finish": {
      // 完了の確認はコマンドが複数ありうるので、**いちばん重い1件に合わせる**（1件でも人が
      // 実行するなら「あなたが実行」）。書かれていなければ担い手が決まらないので押す先の名前だけ
      const verifications = plan.entries.filter((entry) => entry.kind === "verification");
      if (verifications.length === 0) {
        return { tone: "neutral", Icon: Flag, label: "完了の確認", reason: null };
      }
      const marks = verifications.map((entry) => resolveEntryMark(entry, hostName));
      const worst =
        marks.find((mark) => mark.tone === "manual") ??
        marks.find((mark) => mark.tone === "pending") ??
        marks[0];
      return { ...worst, label: `完了の確認（${worst.label}）` };
    }
  }
}

export function ManualStepGuideDialog({
  queueIds,
  issues,
  open,
  onOpenChange,
  onIssueUpdated,
  dispatch: injectedDispatch,
}: {
  /**
   * 案内するIssueのidの並び。開いた時点で確定させた**スナップショット**を渡す
   * （`hooks/use-manual-step-guide.ts`）。Issueそのものではなくidなのは、進めている間に
   * 本文が書き換わっても最新を出すため。
   */
  queueIds: string[];
  /** 画面が持っている全Issue。案内する相手の解決と、前提条件の参照に使う */
  issues: Issue[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssueUpdated: (issue: Issue) => void;
  /**
   * ディスパッチの状態（#1828の代行実行が使う）。**テストから差し込むためだけの口**で、
   * 通常は開いている間だけ自前で取得する（閉じているダイアログのためにポーリングを増やさない）。
   */
  dispatch?: DispatchStateHandle;
}) {
  const ownDispatch = useDispatchState(injectedDispatch === undefined && open);
  const dispatch = injectedDispatch ?? ownDispatch;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ヘッダー・本文・フッターの3段。本文だけをスクロールさせるため、既定の
          `overflow-y-auto`と`gap-4`／`p-4`を打ち消して自前で持つ */}
      <DialogContent
        className="grid max-h-[calc(100%-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        {/* 閉じるとDialogごと外れるので、進んだ位置は自然に捨てられる（次に開くと先頭から） */}
        <GuideSession
          queueIds={queueIds}
          issues={issues}
          dispatch={dispatch}
          onIssueUpdated={onIssueUpdated}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 1回ぶんの案内。**現在地はidで持ち、並びの添字では持たない**——クローズした手作業が
 * ポーリングで一覧から外れると添字がずれ、次の1件を飛ばしてしまう。
 */
function GuideSession({
  queueIds,
  issues,
  dispatch,
  onIssueUpdated,
  onClose,
}: {
  queueIds: string[];
  issues: Issue[];
  dispatch: DispatchStateHandle;
  onIssueUpdated: (issue: Issue) => void;
  onClose: () => void;
}) {
  const issuesById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const [currentId, setCurrentId] = useState<string | null>(
    () => queueIds.find((id) => issuesById.has(id)) ?? null,
  );
  const [stageIndex, setStageIndex] = useState(0);

  const issue = currentId === null ? null : (issuesById.get(currentId) ?? null);

  function goToNextIssue() {
    const at = currentId === null ? -1 : queueIds.indexOf(currentId);
    const next = queueIds.slice(at + 1).find((id) => issuesById.has(id)) ?? null;
    setCurrentId(next);
    setStageIndex(0);
  }

  if (issue === null) {
    return <GuideFinished started={queueIds.length > 0} onClose={onClose} />;
  }

  return (
    <ManualStepGuideContent
      key={issue.id}
      issue={issue}
      issues={issues}
      dispatch={dispatch}
      position={queueIds.indexOf(issue.id) + 1}
      total={queueIds.length}
      stageIndex={stageIndex}
      onStageIndexChange={setStageIndex}
      onNextIssue={goToNextIssue}
      onIssueUpdated={onIssueUpdated}
      onClose={onClose}
    />
  );
}

/** キューを最後まで進めた／案内する相手がいなくなったときの画面 */
function GuideFinished({ started, onClose }: { started: boolean; onClose: () => void }) {
  return (
    <>
      <div className="flex flex-col gap-1 border-b p-4">
        <DialogTitle className="flex items-center gap-1.5 text-violet-700 dark:text-violet-300">
          <Wrench className="size-4 shrink-0" />
          手作業アシスタント
        </DialogTitle>
        <DialogDescription>
          {started
            ? "案内する手作業がすべて終わりました。"
            : "いま実行できる手作業はありません。"}
        </DialogDescription>
      </div>
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <PartyPopper className="size-8 text-violet-500" />
        <p className="text-sm text-muted-foreground">
          {started
            ? "残っている手作業は前提待ちのものだけです。「ユーザーの作業待ち」で状況を確認できます。"
            : "前提が揃った手作業が出てくると、ここから順番に進められます。"}
        </p>
      </div>
      <div className="flex justify-end border-t bg-muted/50 p-3">
        <Button size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </>
  );
}

function ManualStepGuideContent({
  issue,
  issues,
  dispatch,
  position,
  total,
  stageIndex,
  onStageIndexChange,
  onNextIssue,
  onIssueUpdated,
  onClose,
}: {
  issue: Issue;
  issues: Issue[];
  dispatch: DispatchStateHandle;
  position: number;
  total: number;
  stageIndex: number;
  onStageIndexChange: (index: number) => void;
  onNextIssue: () => void;
  onIssueUpdated: (issue: Issue) => void;
  onClose: () => void;
}) {
  const taskList = useIssueTaskList(issue, onIssueUpdated);
  const prerequisites = useManualStepPrerequisites(issue, issues);
  const { updateIssue, isSubmitting, error: closeError } = useIssueMutations();
  // 自動実行の状態はサーバーが持つ（#1882）。**画面は読んで出すだけで、次の1件を積まない**——
  // 画面とサーバーの2か所が積むと、同じ手順が二重に走る
  const autorun = useManualStepAutoRun({
    dispatch,
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
  });

  // 手順とチェック状態の正はIssue本文。トグルの楽観表示（`taskList.body`）を材料にすることで、
  // 「実行した」を押した瞬間にチェックが付いて見える
  const guide = useMemo(() => parseManualStepGuide(taskList.body), [taskList.body]);
  const stages = useMemo(() => buildStages(guide), [guide]);

  // 自動実行（#1869）の計画。**画面・API・pollerが同じ関数から作る**ので、
  // 承認パネルに並んだものと実際に実行されるものがずれない
  const host = resolveManualStepHost(dispatch.hosts);
  const plan = useMemo(
    () =>
      buildManualStepRunPlan(taskList.body, guide, {
        host,
        isManualStepIssue: isManualStepIssue(issue.labels),
      }),
    [taskList.body, guide, host, issue.labels],
  );

  // 確認が通った記録が無いまま閉じようとしていないか（#2256）。Issue詳細の手作業パネルと
  // 同じ判定を通す——2か所で違う条件にすると、同じIssueで聞かれたり聞かれなかったりする
  const closeWarning = useMemo(
    () =>
      resolveManualStepCloseWarning({
        body: taskList.body,
        verifiedAt: issue.manualStepVerifiedAt,
      }),
    [taskList.body, issue.manualStepVerifiedAt],
  );
  const [askedAboutClose, setAskedAboutClose] = useState(false);
  const askingAboutClose = closeWarning !== null && askedAboutClose;

  // 本文が別経路で書き換わって手順が減ることがある。範囲外に居座らせない
  const index = Math.min(stageIndex, stages.length - 1);
  const stage = stages[index];
  const isLast = index === stages.length - 1;

  async function handleClose(stateReason: "completed" | "not_planned") {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "closed",
      stateReason,
    });
    if (!updated) return;
    onIssueUpdated(updated);
    onNextIssue();
  }

  async function handleStepDone() {
    if (stage.kind === "step" && stage.step.line !== null) {
      if (!stage.step.checked) await taskList.toggleTask(stage.step.line, true);
      // 人が実行した手順にチェックを付けたので、止まっていた自動実行は続きから流せる。
      // **次に何を積むかを決めるのはサーバー**（チェックの付いた手順は計画から外れる）
      await autorun.resume();
    }
    onStageIndexChange(index + 1);
  }

  /**
   * 実行済みの取り消し（#2194）。途中で中断していた・実は実行できていなかったと後から
   * 分かったときに、付けたチェックを外す。
   *
   * **外すのはチェックだけで、実行し直しはしない。** 外した手順は自動実行の計画（`plan`）へ
   * 戻るが、積むのはサーバーなので、走らせ直すのは「承認して自動実行」か再開のとき
   * （画面から積まないのは#1882の決まりのまま）。
   */
  async function handleUncheckStep() {
    if (stage.kind !== "step" || stage.step.line === null || !stage.step.checked) return;
    await taskList.toggleTask(stage.step.line, false);
  }

  /**
   * 代行実行（#1828）が終了コード0で終わったときのチェック。
   *
   * **手動で押したときは次の画面へ自動で進めない。** 実行できたことと、出力を見て次へ進んで
   * よいと判断することは別で、勝手に進むと結果を読む前に画面が変わる。付けるのはチェックだけ。
   *
   * **自動実行中はここでチェックを付けない**（#1882）。付けるのはサーバー（GitHub App名義）で、
   * 画面を閉じていても同じように付く。両方で付けようとすると、同じ本文への書き込みが競合する。
   */
  const handleExecuted = useCallback(
    async (executed: ManualStepRunEntry) => {
      if (autorun.active) return;
      if (executed.kind !== "step" || executed.checked) return;
      await taskList.toggleTask(executed.line, true);
    },
    [autorun.active, taskList],
  );

  /**
   * Claudeの修正案（#1869）を適用する。
   *
   * **本文を書き換えてから実行する。** 画面から任意のコマンドを流す経路は作らない——
   * 実行の入口は既存の`POST /api/dispatch`のままで、サーバーは書き換わった本文から
   * コマンドを抽出し直して照合する（`docs/multi-agent/gates.md`）。
   */
  const handleApplyFix = useCallback(
    async (params: { line: number; command: string; run: boolean }) => {
      const nextBody = replaceManualStepCommand(taskList.body, params.line, params.command);
      if (nextBody === null) {
        return {
          ok: false as const,
          message:
            "本文の書き換え先を特定できなかったため、適用しませんでした。手元で本文を直してください。",
        };
      }

      const updated = await updateIssue({
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        body: nextBody,
      });
      if (!updated) return { ok: false as const, message: "本文を書き換えられませんでした。" };
      onIssueUpdated(updated);
      if (!params.run) return { ok: true as const };

      // **自動実行が止まっているだけなら、積むのはサーバーに任せる**（#1882）。ここで直接
      // 積むと、続きから流したサーバーが同じ手順をもう1件積みうる（実行の入口は1つに保つ）
      if (autorun.active) {
        const resumed = await autorun.resume();
        return resumed
          ? { ok: true as const }
          : { ok: false as const, message: "自動実行を再開できませんでした。" };
      }

      if (!host) {
        return { ok: false as const, message: "代行実行できるサブPCが見つかりませんでした。" };
      }
      const result = await dispatch.runManualStep({
        repositoryFullName: issue.repositoryFullName,
        issueNumber: issue.number,
        hostName: host.name,
        stepLine: params.line,
        command: params.command,
      });
      if (!result.ok) return { ok: false as const, message: result.message };
      return { ok: true as const };
    },
    [autorun, dispatch, host, issue, onIssueUpdated, taskList.body, updateIssue],
  );

  // サーバーが流している項目まで画面を進める（#1882）。**進めるのは1項目につき1回**で、
  // 人が前の手順へ戻ったのを引き戻さない
  useManualStepRunNavigation({
    run: autorun.run,
    stages,
    onStageIndexChange,
  });

  // 失敗の自動診断は、**承認した1回に含まれる同意**（サーバーが覚えている）で決まる
  const autoDiagnose = autorun.run?.diagnoseConsent === true && autorun.active;
  /**
   * 自動実行中の「もう一度実行」。**画面からは積まず、続きから流すようサーバーへ頼む**（#1882）。
   * ここで積むと、同じ手順をサーバーがもう1件積みうる（実行の入口を1つに保つ）。
   */
  const autorunRetry = autorun.active
    ? () => {
        void autorun.resume();
      }
    : undefined;

  const stepCount = guide.hasTemplate ? guide.steps.length : 0;
  const currentEntry =
    stage.kind === "step" && stage.step.line !== null
      ? findManualStepEntry(plan, stage.step.line)
      : null;

  return (
    <>
      <header className="flex flex-col gap-1.5 border-b p-4">
        <div className="flex items-center gap-2">
          <DialogTitle className="flex min-w-0 items-center gap-1.5 text-violet-700 dark:text-violet-300">
            <Wrench className="size-4 shrink-0" />
            手作業アシスタント
          </DialogTitle>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {position} / {total} 件目
          </span>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="閉じる">
            <span aria-hidden>✕</span>
          </Button>
        </div>
        <DialogDescription className="flex min-w-0 items-baseline gap-1.5 text-xs">
          <span className="shrink-0 font-mono tabular-nums text-foreground">#{issue.number}</span>
          <span className="truncate">{issue.title}</span>
        </DialogDescription>
      </header>

      <AutoRunBar autorun={autorun} host={host} />

      <div className="flex min-h-0 flex-col overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-muted/60 p-3 backdrop-blur-sm">
          <StageRail
            stages={stages}
            current={index}
            stepCount={stepCount}
            plan={plan}
            hostName={host?.name ?? "サブPC"}
            onSelect={onStageIndexChange}
          />
          {/* デバイスは**いま開いている手順のもの**（#2052）。手順にデバイスが書かれて
              いなければ手作業の既定値へ落ちる */}
          <WhereChips
            where={guide.where}
            device={
              stage.kind === "step"
                ? resolveManualStepDevice(guide.where, stage.step)
                : guide.where.defaultDevice
            }
          />
        </div>

        <div className="flex flex-col gap-3 p-4">
          {stage.kind === "overview" && (
            <>
              <OverviewStage guide={guide} issue={issue} prerequisites={prerequisites} />
              {/* 押す1回で実行される全文を、押す前に並べる（#1869） */}
              {!autorun.active && (
                <ManualStepAutoRunPanel
                  plan={plan}
                  hostName={host?.name ?? "サブPC"}
                  consent={autorun.consent}
                  onConsentChange={autorun.setConsent}
                  onApprove={() => {
                    if (host) void autorun.start(host.name);
                  }}
                  isSubmitting={autorun.isSubmitting || dispatch.isSubmitting}
                />
              )}
            </>
          )}
          {stage.kind === "step" && (
            <StepStage
              step={stage.step}
              order={stage.order}
              total={stepCount}
              mark={resolveStageMark(stage, plan, host?.name ?? "サブPC")}
              issue={issue}
              guide={guide}
              dispatch={dispatch}
              entry={currentEntry}
              autoDiagnose={autoDiagnose}
              isToggling={taskList.isToggling}
              onExecuted={handleExecuted}
              onUncheck={() => void handleUncheckStep()}
              onRetry={autorunRetry}
              onApplyFix={handleApplyFix}
            />
          )}
          {stage.kind === "body" && <BodyStage issue={issue} body={taskList.body} />}
          {stage.kind === "finish" && (
            <FinishStage
              guide={guide}
              issue={issue}
              plan={plan}
              dispatch={dispatch}
              autoDiagnose={autoDiagnose}
              onExecuted={handleExecuted}
              onRetry={autorunRetry}
              onApplyFix={handleApplyFix}
              asking={askingAboutClose}
            />
          )}
          <ApiErrorMessage message={taskList.error ?? closeError} />
        </div>
      </div>

      <footer className="flex flex-col gap-2 border-t bg-muted/50 p-3 sm:flex-row sm:items-center">
        {index > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onStageIndexChange(index - 1)}
            className="sm:order-1"
          >
            <ChevronLeft />
            戻る
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onNextIssue} className="sm:order-1">
            この手作業は飛ばす
          </Button>
        )}
        <div className="flex flex-col-reverse gap-2 sm:order-3 sm:ml-auto sm:flex-row">
          {/* 自動実行は**いつでも中断できる**（#1882）。次を積まないだけでなく、走っている
              1件も止める（止められないホストでは、その旨が中断後のメッセージに出る） */}
          {autorun.active && (
            <Button
              variant="outline"
              size="sm"
              disabled={autorun.isSubmitting}
              onClick={() => void autorun.stop()}
            >
              {autorun.isSubmitting ? <Loader2 className="animate-spin" /> : <CircleStop />}
              中断する
            </Button>
          )}
          {isLast ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={isSubmitting}
                onClick={() => handleClose("not_planned")}
              >
                <Ban />
                実施せずクローズ
              </Button>
              <Button
                size="sm"
                disabled={isSubmitting}
                // **1回だけ聞き返して、2回目はそのまま閉じる**（#2256）。確かめようのない
                // 手作業は実際にあるので、押せなくはしない
                onClick={() => {
                  if (closeWarning !== null && !askedAboutClose) {
                    setAskedAboutClose(true);
                    return;
                  }
                  void handleClose("completed");
                }}
              >
                {isSubmitting ? (
                  <Loader2 className="animate-spin" />
                ) : askingAboutClose ? (
                  <TriangleAlert />
                ) : (
                  <CheckCircle2 />
                )}
                {askingAboutClose ? "確認せずクローズ" : "完了してクローズ"}
              </Button>
            </>
          ) : stage.kind === "step" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onStageIndexChange(index + 1)}>
                あとで
              </Button>
              {/* 代行実行が成功するとチェックが付く（#1828）。**そのときは主導線を「次へ」に
                  変える**——既に実行済みの手順に「実行した」を押させると、押さないと進めないのか
                  分からなくなる */}
              <Button
                size="sm"
                disabled={taskList.isToggling || autorun.running}
                onClick={() => void handleStepDone()}
              >
                {taskList.isToggling ? (
                  <Loader2 className="animate-spin" />
                ) : stage.step.checked ? (
                  <ArrowRight />
                ) : (
                  <Check />
                )}
                {stage.step.checked ? "次へ" : "実行した・次へ"}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => onStageIndexChange(index + 1)}>
              {stage.kind === "overview" ? "はじめる" : "次へ"}
              <ArrowRight />
            </Button>
          )}
        </div>
      </footer>
    </>
  );
}

/**
 * 進み具合のレール。**押せる目次にする**（#2194。#1826では「順番に案内するのがこの画面の
 * 役目」として押せなくしていた判断を覆した）。押しても本文のチェックは変わらない——
 * チェックが付くのは「実行した・次へ」と代行実行が終了コード0で終わったときだけなので、
 * 先の手順へ飛べても記録は飛ばせない。前の手順へ戻るのに「戻る」を回数ぶん押す必要が
 * あったのが、実際に困っていたところ。
 *
 * **ドットの形で担い手も出す**（#2194）。代行できるのか自分で実行するのかは、これまで
 * 最初の画面の承認パネルを開き直さないと分からなかった。
 */
function StageRail({
  stages,
  current,
  stepCount,
  plan,
  hostName,
  onSelect,
}: {
  stages: GuideStage[];
  current: number;
  stepCount: number;
  plan: ManualStepRunPlan;
  hostName: string;
  onSelect: (index: number) => void;
}) {
  const caption = stageCaption(stages[current], stepCount);

  return (
    <div className="flex items-start gap-2">
      {/* 手順の多い手作業では折り返す（横スクロールにすると、スマホで見えない手順が出る） */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {stages.map((stage, order) => {
          const mark = resolveStageMark(stage, plan, hostName);
          const described =
            stage.kind === "step"
              ? `手順 ${stage.order + 1} / ${stepCount}: ${mark.label} — ${stage.step.text}`
              : mark.label;
          // ドットには理由文を書く場所が無いので、`title`・読み上げへ足す（#2194）
          const label = mark.reason === null ? described : `${described}（${mark.reason}）`;
          return (
            <span key={order} className="flex items-center gap-1">
              {order > 0 && (
                <span
                  className={cn(
                    "h-px w-2.5 rounded-full",
                    order <= current ? "bg-violet-500/60" : "bg-border",
                  )}
                />
              )}
              <button
                type="button"
                title={label}
                aria-label={label}
                aria-current={order === current ? "step" : undefined}
                onClick={() => onSelect(order)}
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                  "hover:brightness-105 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                  STAGE_MARK_TONE[mark.tone],
                  order === current && STAGE_MARK_CURRENT_TONE[mark.tone],
                )}
              >
                <mark.Icon className="size-3" aria-hidden />
              </button>
            </span>
          );
        })}
      </div>
      <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{caption}</span>
    </div>
  );
}

function stageCaption(stage: GuideStage, stepCount: number): string {
  switch (stage.kind) {
    case "step":
      return `手順 ${stage.order + 1} / ${stepCount}`;
    case "overview":
      return "この作業の目的";
    case "body":
      return "やること";
    case "finish":
      return "完了の確認";
  }
}

/**
 * 実行する場所。**どのステップでも同じ位置に出したままにする**——手順だけを見て
 * 手元の端末で打ってしまう事故を防ぐのがこのチップの役目で、最初の画面にだけ出すと
 * 手順へ進んだ時点で消える。
 */
function WhereChips({
  where,
  device,
}: {
  where: ManualStepGuide["where"];
  /**
   * いま出している手順のデバイス（#2052）。既定値が決まらない本文（端末が複数書かれている）で
   * デバイスの無い手順を開くと`null`になるので、そのときだけ書かれた値をそのまま出す——
   * 判定には使えないが、読む人にとっては本文に書いてあることが分かる方がよい。
   */
  device: string | null;
}) {
  const chips = [
    { icon: MonitorSmartphone, value: device ?? where.device, label: "実行するデバイス" },
    { icon: FolderOpen, value: where.directory, label: "カレントディレクトリ" },
    { icon: GitBranch, value: where.branch, label: "Gitブランチ" },
  ].filter((chip): chip is typeof chip & { value: string } => chip.value !== null);

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">実行する場所</span>
      {chips.map(({ icon: Icon, value, label }) => (
        <span
          key={label}
          title={`${label}: ${value}`}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs"
        >
          <Icon className="size-3 shrink-0 text-muted-foreground" aria-label={label} />
          <span className="truncate">{value}</span>
        </span>
      ))}
    </div>
  );
}

function OverviewStage({
  guide,
  issue,
  prerequisites,
}: {
  guide: ManualStepGuide;
  issue: Issue;
  prerequisites: ReturnType<typeof useManualStepPrerequisites>;
}) {
  const empty =
    guide.outcome === null && guide.todoIntro === null && prerequisites.summary === null;

  return (
    <>
      {guide.outcome !== null && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground">
            この作業でできるようになること
          </h3>
          <MarkdownBody
            content={guide.outcome}
            repositoryFullName={issue.repositoryFullName}
            className="text-sm"
          />
        </section>
      )}

      {prerequisites.summary !== null && (
        <ManualStepPrerequisites
          prerequisites={prerequisites.prerequisites}
          summary={prerequisites.summary}
          repositoryFullName={issue.repositoryFullName}
          titleId="manual-step-guide-prerequisites-title"
        />
      )}

      {guide.todoIntro !== null && (
        <section className="flex flex-col gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
          <h3 className="text-xs font-semibold text-violet-700 dark:text-violet-300">
            始める前に
          </h3>
          <MarkdownBody
            content={guide.todoIntro}
            repositoryFullName={issue.repositoryFullName}
            className="text-sm"
          />
        </section>
      )}

      {empty && (
        <p className="text-sm text-muted-foreground">
          この手作業には目的・前提条件が書かれていません。次の画面から手順を進めてください。
        </p>
      )}
    </>
  );
}

function StepStage({
  step,
  order,
  total,
  mark,
  issue,
  guide,
  dispatch,
  entry,
  autoDiagnose,
  isToggling,
  onExecuted,
  onUncheck,
  onRetry,
  onApplyFix,
}: {
  step: ManualStepGuideStep;
  order: number;
  total: number;
  /** レールのドットと同じ印（#2194）。**同じ関数から作る**ので、上の丸と見出しがずれない */
  mark: StageMark;
  issue: Issue;
  guide: ManualStepGuide;
  dispatch: DispatchStateHandle;
  /** 実行計画上のこの手順。チェックリストでない本文では`null` */
  entry: ManualStepRunEntry | null;
  autoDiagnose: boolean;
  isToggling: boolean;
  onExecuted: (entry: ManualStepRunEntry) => void;
  /** 実行済みの取り消し（#2194） */
  onUncheck: () => void;
  /** 「もう一度実行」を自前で扱う場合（自動実行中は積み直さず、続きから流す。#1882） */
  onRetry?: () => void;
  onApplyFix: ManualStepApplyFix;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <span className="tabular-nums">
            手順 {order + 1} / {total}
          </span>
          {/* 担い手（代行できる／あなたが実行／実行済み）を出す。**コマンドを読む前に**
              自分で実行するのか待てばよいのかが分かるようにする（#2194） */}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-px text-[11px] leading-4",
              STAGE_MARK_BADGE_TONE[mark.tone],
            )}
          >
            <mark.Icon className="size-3" aria-hidden />
            {mark.label}
          </span>
        </h3>
        {/* 押した後で「実は実行できていなかった」と分かることがある（#2194）。
            外すのはチェックだけで、実行し直しはしない */}
        {step.checked && step.line !== null && (
          <Button variant="outline" size="xs" disabled={isToggling} onClick={onUncheck}>
            {isToggling ? <Loader2 className="animate-spin" /> : <Undo2 />}
            実行済みを取り消す
          </Button>
        )}
      </div>
      {/* コードブロックのコピーボタン（#1726）と`#123`のリンクをそのまま使うため、
          手順もMarkdownとして描く。チェックボックスは`- [ ]`ごと外してあるので、
          この中には出ない（付けるのはフッターの「実行した・次へ」） */}
      <MarkdownBody content={step.markdown} repositoryFullName={issue.repositoryFullName} />
      {/* サブPCで実行する手順は、承認1回で代行できる（#1828）。できない場合も理由を出す */}
      {entry !== null && (
        <ManualStepRunPanel
          issue={issue}
          guide={guide}
          entry={entry}
          dispatch={dispatch}
          autoDiagnose={autoDiagnose}
          onSucceeded={() => onExecuted(entry)}
          onRetry={onRetry}
          onApplyFix={onApplyFix}
        />
      )}
    </section>
  );
}

function BodyStage({ issue, body }: { issue: Issue; body: string }) {
  return (
    <section className="flex flex-col gap-2">
      <p className="rounded-md border bg-muted/50 p-2.5 text-xs text-muted-foreground">
        この手作業の本文は手順のチェックリスト（<code>## やること</code>
        ）を持たないため、順番に割れませんでした。本文をそのまま出します。
      </p>
      <MarkdownBody content={body} repositoryFullName={issue.repositoryFullName} />
    </section>
  );
}

function FinishStage({
  guide,
  issue,
  plan,
  dispatch,
  autoDiagnose,
  onExecuted,
  onRetry,
  onApplyFix,
  asking,
}: {
  guide: ManualStepGuide;
  issue: Issue;
  plan: ManualStepRunPlan;
  dispatch: DispatchStateHandle;
  autoDiagnose: boolean;
  /** 確認が通った記録が無いまま「完了してクローズ」を押されたか（#2256） */
  asking: boolean;
  onExecuted: (entry: ManualStepRunEntry) => void;
  onRetry?: () => void;
  onApplyFix: ManualStepApplyFix;
}) {
  const verifications = plan.entries.filter((entry) => entry.kind === "verification");

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">完了の確認方法</h3>
      {/* 確認が通った記録が無いまま閉じようとしたとき（#2256）。**コマンドはこのすぐ下に
          並んでいる**ので、ここでは何が足りないかだけを言い、もう一度出し直さない */}
      {asking && (
        <p className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {"下の確認コマンドが通った記録がありません。流してから閉じてください。" +
              "確かめようがない手作業なら、もう一度「確認せずクローズ」を押せば閉じられます。"}
          </span>
        </p>
      )}
      {guide.verification === null ? (
        <p className="text-sm text-muted-foreground">
          この手作業には確認方法が書かれていません。実行し終えていればクローズしてください。
        </p>
      ) : (
        <MarkdownBody
          content={guide.verification}
          repositoryFullName={issue.repositoryFullName}
        />
      )}
      {/* 確認のコマンドも代行できる（#1869）。**実行しても完了にはならない**——
          終了コードは見るが「期待する出力」との照合はしないので、判断するのは人 */}
      {verifications.map((entry) => (
        <ManualStepRunPanel
          key={entry.line}
          issue={issue}
          guide={guide}
          entry={entry}
          dispatch={dispatch}
          autoDiagnose={autoDiagnose}
          onSucceeded={() => onExecuted(entry)}
          onRetry={onRetry}
          onApplyFix={onApplyFix}
        />
      ))}
    </section>
  );
}

/** 修正案を本文へ書き戻して（必要なら）実行する（#1869） */
type ManualStepApplyFix = (params: {
  line: number;
  command: string;
  run: boolean;
}) => Promise<{ ok: boolean; message?: string }>;

/**
 * 自動実行の進み具合（#1869・#1882）。**止まったときはその理由まで出す**——止まっていることに
 * 気づかないまま画面を見続けるのがいちばん困る状態で、次に何を押せばよいかも変わる。
 *
 * **「この画面を閉じても続きます」を常に出す**（#1882）。進めているのはサーバーなので、
 * 閉じてよいことが分からないと、終わるまで画面の前で待つことになる（それが元の作りだった）。
 */
function AutoRunBar({
  autorun,
  host,
}: {
  autorun: ManualStepAutoRunHandle;
  host: DispatchHostView | null;
}) {
  const run = autorun.run;
  if (run === null || !isActiveManualStepRun(run.status)) return null;

  const failed = run.pausedReason === "FAILED" || run.pausedReason === "ENQUEUE_FAILED";
  const abortRejection =
    run.status === "RUNNING" ? resolveManualStepAbortRejection(host) : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-xs font-semibold",
        failed
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      role="status"
    >
      {run.status === "RUNNING" && (
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      )}
      <span className="tabular-nums">{describeManualStepRun(run)}</span>
      <span className="font-normal text-muted-foreground">
        {run.status === "RUNNING"
          ? "・この画面を閉じても続きます"
          : run.message !== null
            ? `・${run.message}`
            : ""}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <span className="h-1 w-16 overflow-hidden rounded-full bg-current/20">
          <span
            className="block h-full bg-current"
            style={{ width: `${manualStepRunProgressPercent(run)}%` }}
          />
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={autorun.isSubmitting}
          onClick={() => void autorun.stop()}
        >
          {autorun.isSubmitting ? <Loader2 className="animate-spin" /> : <CircleStop />}
          中断する
        </Button>
      </span>
      {abortRejection !== null && (
        <span className="basis-full font-normal text-muted-foreground">
          {describeManualStepAbortRejection(abortRejection, {
            hostName: run.targetHost,
            timeoutMinutes: MANUAL_STEP_TIMEOUT_SECONDS / 60,
          })}
        </span>
      )}
      {autorun.error !== null && (
        <span className="basis-full font-normal text-destructive">{autorun.error}</span>
      )}
    </div>
  );
}

/**
 * サーバーが流している項目まで画面を進める（#1882）。
 *
 * **進めるのは1項目につき1回。** 人が前の手順へ戻ったのを引き戻さない（自動実行中でも
 * 出力を読み返せる）。#1869では画面が次を積んでいたためこの関数が制御そのものだったが、
 * いまは表示を追従させるだけ。
 */
function useManualStepRunNavigation({
  run,
  stages,
  onStageIndexChange,
}: {
  run: ManualStepRunView | null;
  stages: GuideStage[];
  onStageIndexChange: (index: number) => void;
}) {
  const navigatedFor = useRef<number | null>(null);
  const line = run !== null && isActiveManualStepRun(run.status) ? run.currentLine : null;

  useEffect(() => {
    if (line === null) {
      navigatedFor.current = null;
      return;
    }
    if (navigatedFor.current === line) return;
    navigatedFor.current = line;

    const target = stages.findIndex(
      (stage) => stage.kind === "step" && stage.step.line === line,
    );
    // 手順に無い行＝`## 完了の確認方法`のコマンド。最後の画面で待つ
    onStageIndexChange(target >= 0 ? target : stages.length - 1);
  }, [line, stages, onStageIndexChange]);
}
