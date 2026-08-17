"use client";

import {
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronLeft,
  FolderOpen,
  GitBranch,
  Loader2,
  MonitorSmartphone,
  PartyPopper,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueTaskList } from "@/hooks/use-issue-task-list";
import { useManualStepPrerequisites } from "@/hooks/use-manual-step-prerequisites";
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
}) {
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
  onIssueUpdated,
  onClose,
}: {
  queueIds: string[];
  issues: Issue[];
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

  // 手順とチェック状態の正はIssue本文。トグルの楽観表示（`taskList.body`）を材料にすることで、
  // 「実行した」を押した瞬間にチェックが付いて見える
  const guide = useMemo(() => parseManualStepGuide(taskList.body), [taskList.body]);
  const stages = useMemo(() => buildStages(guide), [guide]);

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
    if (stage.kind === "step" && stage.step.line !== null && !stage.step.checked) {
      await taskList.toggleTask(stage.step.line, true);
    }
    onStageIndexChange(index + 1);
  }

  const stepCount = guide.hasTemplate ? guide.steps.length : 0;

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

      <div className="flex min-h-0 flex-col overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-muted/60 p-3 backdrop-blur-sm">
          <StageRail stages={stages} current={index} stepCount={stepCount} />
          <WhereChips where={guide.where} />
        </div>

        <div className="flex flex-col gap-3 p-4">
          {stage.kind === "overview" && (
            <OverviewStage guide={guide} issue={issue} prerequisites={prerequisites} />
          )}
          {stage.kind === "step" && (
            <StepStage step={stage.step} order={stage.order} total={stepCount} issue={issue} />
          )}
          {stage.kind === "body" && <BodyStage issue={issue} body={taskList.body} />}
          {stage.kind === "finish" && <FinishStage guide={guide} issue={issue} />}
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
              <Button
                size="sm"
                disabled={taskList.isToggling}
                onClick={() => void handleStepDone()}
              >
                {taskList.isToggling ? <Loader2 className="animate-spin" /> : <Check />}
                実行した・次へ
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
}: {
  step: ManualStepGuideStep;
  order: number;
  total: number;
  issue: Issue;
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

function FinishStage({ guide, issue }: { guide: ManualStepGuide; issue: Issue }) {
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
    </section>
  );
}
