"use client";

import {
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleStop,
  FolderOpen,
  GitBranch,
  Loader2,
  MonitorSmartphone,
  PartyPopper,
  Wrench,
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
import {
  findManualStepJobForStep,
  isActiveDispatchJobStatus,
  resolveManualStepHost,
} from "@/lib/dispatch/dispatch-job";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  buildManualStepRunPlan,
  findManualStepEntry,
  findNextManualStepEntry,
  type ManualStepRunEntry,
  type ManualStepRunPlan,
} from "@/lib/manual-step-autorun";
import { replaceManualStepCommand } from "@/lib/manual-step-command";
import {
  parseManualStepGuide,
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
  const autorun = useManualStepAutoRun();

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
      // 人が実行した項目も「流し終えた」扱いにして、自動実行を先へ進める
      autorun.markDone(stage.step.line);
      autorun.resume();
    }
    onStageIndexChange(index + 1);
  }

  /**
   * 代行実行（#1828）が終了コード0で終わったときのチェック。
   *
   * **手動で押したときは次の画面へ自動で進めない。** 実行できたことと、出力を見て次へ進んで
   * よいと判断することは別で、勝手に進むと結果を読む前に画面が変わる。付けるのはチェックだけ。
   * 自動実行中（#1869）は、承認した時点でそこまで含めて任されているので下の制御が先へ進める。
   */
  const handleExecuted = useCallback(
    async (executed: ManualStepRunEntry) => {
      autorun.markDone(executed.line);
      if (executed.kind !== "step" || executed.checked) return;
      await taskList.toggleTask(executed.line, true);
    },
    [autorun, taskList],
  );

  /**
   * 実行が失敗したとき。**自動実行はそこで止める**（次の手順へ進めない）。
   *
   * ただし**自動実行が流している最中は、止めるかどうかを下の制御だけが決める**。画面に出ている
   * のは前回の実行で失敗したジョブのこともあり（終わったジョブは24時間残る）、それを理由に
   * 止めると、これから積む1件を実行する前に止まってしまう。
   */
  const handleFailed = useCallback(() => {
    if (autorun.running) return;
    autorun.pause("failed");
  }, [autorun]);

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
      // 失敗で止まっていた自動実行は、直したので続きから流す
      autorun.resume();
      return { ok: true as const };
    },
    [autorun, dispatch, host, issue, onIssueUpdated, taskList.body, updateIssue],
  );

  useManualStepAutoRunController({
    autorun,
    plan,
    stages,
    dispatch,
    issue,
    host,
    onStageIndexChange,
  });

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

      <AutoRunBar autorun={autorun} plan={plan} />

      <div className="flex min-h-0 flex-col overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-muted/60 p-3 backdrop-blur-sm">
          <StageRail stages={stages} current={index} stepCount={stepCount} />
          <WhereChips where={guide.where} />
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
                  device={guide.where.device}
                  consent={autorun.consent}
                  onConsentChange={autorun.setConsent}
                  onApprove={autorun.start}
                  isSubmitting={dispatch.isSubmitting}
                />
              )}
            </>
          )}
          {stage.kind === "step" && (
            <StepStage
              step={stage.step}
              order={stage.order}
              total={stepCount}
              issue={issue}
              guide={guide}
              dispatch={dispatch}
              entry={currentEntry}
              autoDiagnose={autorun.active && autorun.consent}
              onExecuted={handleExecuted}
              onFailed={handleFailed}
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
              autoDiagnose={autorun.active && autorun.consent}
              onExecuted={handleExecuted}
              onFailed={handleFailed}
              onApplyFix={handleApplyFix}
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
          {/* 自動実行は**いつでも止められる**（#1869）。押すと積んだぶんは走り切るが、次は積まない */}
          {autorun.active && (
            <Button variant="outline" size="sm" onClick={autorun.stop}>
              <CircleStop />
              自動実行を停止
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
              <Button size="sm" disabled={isSubmitting} onClick={() => handleClose("completed")}>
                {isSubmitting ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                完了してクローズ
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
 * 進み具合のドット列。**押せる目次にはしない**——順番に案内するのがこの画面の役目で、
 * 好きな手順へ飛べるようにすると、実行した記録（チェック）を飛ばしたまま最後まで進める。
 */
function StageRail({
  stages,
  current,
  stepCount,
}: {
  stages: GuideStage[];
  current: number;
  stepCount: number;
}) {
  const stage = stages[current];
  const caption =
    stage.kind === "step"
      ? `手順 ${stage.order + 1} / ${stepCount}`
      : stage.kind === "overview"
        ? "この作業の目的"
        : stage.kind === "body"
          ? "やること"
          : "完了の確認";

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="flex items-center gap-1.5"
        role="img"
        aria-label={`全${stages.length}段のうち${current + 1}段目（${caption}）`}
      >
        {stages.map((_, order) => (
          <span key={order} className="flex items-center gap-1.5">
            {order > 0 && (
              <span
                className={cn(
                  "h-px w-3 rounded-full",
                  order <= current ? "bg-violet-500/60" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "size-2 rounded-full",
                order < current && "bg-emerald-500",
                order === current && "bg-violet-500 ring-3 ring-violet-500/20",
                order > current && "bg-border",
              )}
            />
          </span>
        ))}
      </span>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{caption}</span>
    </div>
  );
}

/**
 * 実行する場所。**どのステップでも同じ位置に出したままにする**——手順だけを見て
 * 手元の端末で打ってしまう事故を防ぐのがこのチップの役目で、最初の画面にだけ出すと
 * 手順へ進んだ時点で消える。
 */
function WhereChips({ where }: { where: ManualStepGuide["where"] }) {
  const chips = [
    { icon: MonitorSmartphone, value: where.device, label: "実行するデバイス" },
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
  issue,
  guide,
  dispatch,
  entry,
  autoDiagnose,
  onExecuted,
  onFailed,
  onApplyFix,
}: {
  step: ManualStepGuideStep;
  order: number;
  total: number;
  issue: Issue;
  guide: ManualStepGuide;
  dispatch: DispatchStateHandle;
  /** 実行計画上のこの手順。チェックリストでない本文では`null` */
  entry: ManualStepRunEntry | null;
  autoDiagnose: boolean;
  onExecuted: (entry: ManualStepRunEntry) => void;
  onFailed: () => void;
  onApplyFix: ManualStepApplyFix;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <span className="tabular-nums">
          手順 {order + 1} / {total}
        </span>
        {step.checked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-px text-[11px] leading-4 text-emerald-700 dark:text-emerald-300">
            <Check className="size-3" />
            実行済み
          </span>
        )}
      </h3>
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
          onFailed={onFailed}
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
  onFailed,
  onApplyFix,
}: {
  guide: ManualStepGuide;
  issue: Issue;
  plan: ManualStepRunPlan;
  dispatch: DispatchStateHandle;
  autoDiagnose: boolean;
  onExecuted: (entry: ManualStepRunEntry) => void;
  onFailed: () => void;
  onApplyFix: ManualStepApplyFix;
}) {
  const verifications = plan.entries.filter((entry) => entry.kind === "verification");

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">完了の確認方法</h3>
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
          onFailed={onFailed}
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
 * 自動実行の進み具合（#1869）。**止まったときはその理由まで出す**——止まっていることに
 * 気づかないまま画面を見続けるのがいちばん困る状態で、次に何を押せばよいかも変わる。
 */
function AutoRunBar({
  autorun,
  plan,
}: {
  autorun: ManualStepAutoRunHandle;
  plan: ManualStepRunPlan;
}) {
  if (!autorun.active) return null;

  const total = plan.entries.length;
  const done = plan.entries.filter(
    (entry) => entry.checked || autorun.doneLines.has(entry.line),
  ).length;

  const message =
    autorun.pausedBy === "user"
      ? "あなたが実行する手順で止まっています"
      : autorun.pausedBy === "failed"
        ? "失敗したため止まっています"
        : `自動実行中 ${Math.min(done + 1, total)} / ${total}`;

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-2 text-xs font-semibold",
        autorun.pausedBy === "failed"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      role="status"
    >
      {autorun.pausedBy === null && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
      <span className="tabular-nums">{message}</span>
      <span className="ml-auto h-1 w-24 shrink-0 overflow-hidden rounded-full bg-current/20">
        <span
          className="block h-full bg-current"
          style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
        />
      </span>
    </div>
  );
}

/**
 * 自動実行を進める制御（#1869）。
 *
 * **積むのは1件ずつで、前の1件が終わってから次を積む。** 代行実行の`activeKey`はIssue単位
 * （同じIssueの未処理は1件まで）で、順番に実行する前提の手順（`git pull` → 再起動）が
 * 入れ替わらないようにするための決まりでもある。
 *
 * 止まる条件は3つ。**どれも「勝手に進まない」側へ倒している。**
 *
 * - 代行できない項目に来た（人が実行して「実行した・次へ」を押すと続きから流れる）
 * - 実行が失敗した（原因と修正案を見て、直してから続ける）
 * - 積めなかった（起動先が居ない・本文が変わった等。理由はパネルに出る）
 *
 * 最後まで流れても**クローズはしない**。完了の確認の画面で止まり、押すのは人。
 */
function useManualStepAutoRunController({
  autorun,
  plan,
  stages,
  dispatch,
  issue,
  host,
  onStageIndexChange,
}: {
  autorun: ManualStepAutoRunHandle;
  plan: ManualStepRunPlan;
  stages: GuideStage[];
  dispatch: DispatchStateHandle;
  issue: Issue;
  host: { name: string } | null;
  onStageIndexChange: (index: number) => void;
}) {
  /**
   * この承認で積んだ行と、**積む直前にその行について画面が持っていたジョブのid**。
   *
   * 終わったジョブは24時間画面に残る（`FINISHED_JOB_RETENTION_MS`）ため、前回の実行で失敗した
   * ジョブがそのまま出ていることがある。積んだ結果を見るときに**それを結果と取り違えない**
   * ように、押す前から在ったidを覚えて除ける。時刻で見分けないのは、画面と実行先の時計が
   * 揃っている保証が無いため。
   */
  const enqueued = useRef<Map<number, Set<string>>>(new Map());
  /** 画面をその項目まで進めたか。**進めるのは1項目につき1回**（人が戻ったのを引き戻さない） */
  const navigatedFor = useRef<number | null>(null);

  const { active, running } = autorun;
  useEffect(() => {
    if (active) return;
    enqueued.current = new Map();
    navigatedFor.current = null;
  }, [active]);

  const next = running ? findNextManualStepEntry(plan, autorun.doneLines) : null;

  useEffect(() => {
    if (!running) return;

    // 流すものが無くなった＝手順も確認も終わり。完了の確認の画面で止める
    if (next === null) {
      autorun.stop();
      onStageIndexChange(stages.length - 1);
      return;
    }

    if (navigatedFor.current !== next.line) {
      navigatedFor.current = next.line;
      const target =
        next.kind === "verification"
          ? stages.length - 1
          : stages.findIndex((stage) => stage.kind === "step" && stage.step.line === next.line);
      if (target >= 0) onStageIndexChange(target);
    }

    // 代行できない項目。人が実行して「実行した・次へ」を押すまで待つ
    if (next.rejection !== null || next.command === null) {
      autorun.pause("user");
      return;
    }

    const before = enqueued.current.get(next.line);
    if (before !== undefined) {
      const job = findManualStepJobForStep(
        dispatch.jobs,
        issue.repositoryFullName,
        issue.number,
        next.line,
      );
      // 押す前から在ったジョブしか無い＝積んだぶんがまだ画面に届いていない
      if (job === null || before.has(job.id) || isActiveDispatchJobStatus(job.status)) return;
      if (job.status === "SUCCEEDED" && job.exitCode === 0) {
        autorun.markDone(next.line);
        return;
      }
      // 失敗・打ち切り・見送り。**チェックも付けず、次へも進めない**
      autorun.pause("failed");
      return;
    }

    if (dispatch.isSubmitting || host === null) return;
    enqueued.current.set(
      next.line,
      new Set(
        dispatch.jobs
          .filter(
            (job) =>
              job.repositoryFullName === issue.repositoryFullName &&
              job.issueNumber === issue.number &&
              job.manualStepLine === next.line,
          )
          .map((job) => job.id),
      ),
    );
    void dispatch
      .runManualStep({
        repositoryFullName: issue.repositoryFullName,
        issueNumber: issue.number,
        hostName: host.name,
        stepLine: next.line,
        command: next.command,
      })
      .then((result) => {
        if (!result.ok) autorun.pause("failed");
      });
  }, [running, next, plan, stages, dispatch, issue, host, autorun, onStageIndexChange]);
}
