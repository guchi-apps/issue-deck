"use client";

import { Ban, CheckCircle2, ListChecks, Loader2, Wrench } from "lucide-react";

import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import { Button } from "@/components/ui/button";
import type {
  ManualStepPrerequisite,
  ManualStepPrerequisiteSummary,
} from "@/lib/manual-step-prerequisites";
import { cn } from "@/lib/utils";

/**
 * 手作業Issue（`71.manual-step`）の詳細画面に出す、実行者向けの判断材料と出口（#1280）。
 *
 * 手作業Issueは**エージェントへ送らないIssue**でありながら、進捗が`Ready`のまま留まる。
 * そのため以前は「実装を開始」が主ボタンとして出たまま、完了の導線は「…」メニューの
 * 「クローズする」の奥にしか無く、実行し終えたユーザーが次に何をすればよいか画面から
 * 読み取れなかった。ここで「終わったらクローズすること」を出口として1か所に出す。
 *
 * **出すのは「前提条件の状況」と2つのクローズボタンだけにする**（#1732）。以前は
 * 「エージェントへは送らない」旨の説明と5項目の手順リスト、進捗Statusの補足も並べていたが、
 * 手順リストは本文テンプレートの見出し（`## 前提条件`・`## やること`・`## 完了の確認方法`）を
 * なぞっただけで、すぐ下に出る本文と重複していた。毎回同じ文面が縦に積まれ、実行してよいかの
 * 判断材料と出口が押し下げられる方が損が大きい。運用の説明はdocs/multi-agent/labels.mdに置く。
 *
 * **手順そのものはここに並べず、「順番に進める」（手作業アシスタント・#1826）へ渡す**。
 * 本文をなぞる説明を戻すのではなく、1手順ずつ案内する別の画面へ送る形にしている。
 *
 * 配色にamberを使わないのは、amberが「ユーザーの確認待ち」（`00.check-user`）の色として
 * 使われているため（sidebar-nav・workflow-status-steps）。承認して再開させる先がある
 * 確認待ちと、実行者が人である手作業とを、盤面で混同させない。violetは`71.manual-step`
 * ラベル自体の色（`d876e3`、cross-repo-setup-guide.md）に合わせている。
 */
export function ManualStepPanel({
  onComplete,
  onSkip,
  onStartGuide,
  isSubmitting,
  prerequisites,
  prerequisiteSummary,
  repositoryFullName,
  className,
}: {
  /** 手作業を実行し終えた場合（完了としてクローズ） */
  onComplete: () => void;
  /** 実施せず終わらせる場合（計画外としてクローズ） */
  onSkip: () => void;
  /**
   * 手作業アシスタント（#1826）をこのIssueから開く。渡さない場合はボタンを出さない
   * （アシスタントを置いていない画面から使われたとき、押せない導線を残さないため）
   */
  onStartGuide?: () => void;
  isSubmitting: boolean;
  /**
   * 待っている相手（先に完了している必要があるIssue・PR）の状況（#1705）。
   * `hooks/use-manual-step-prerequisites.ts`の結果をそのまま渡す。**PC・スマホの
   * どちらの詳細からも渡すこと**——片方だけだと「実行してよいか」の答えが画面で食い違う。
   */
  prerequisites?: ManualStepPrerequisite[];
  /** 参照が1件も無ければnull。そのときは前提条件のブロックごと出さない */
  prerequisiteSummary?: ManualStepPrerequisiteSummary | null;
  repositoryFullName?: string;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-violet-500/40 bg-violet-500/5 p-3",
        className,
      )}
      aria-labelledby="manual-step-panel-title"
    >
      <p
        id="manual-step-panel-title"
        className="flex items-center gap-1.5 text-sm font-medium text-violet-700 dark:text-violet-300"
      >
        <Wrench className="size-4 shrink-0" />
        あなたの手作業を待っています
      </p>
      {/* 待っている相手の状況（#1705）。実行してよいかの判断材料なので、出口のボタンより先に出す。
          **前提が揃っていなくてもボタンは押せるままにする**——ここの判定は本文に書かれた
          番号からの推定で、外したときに完了できなくなる方が損が大きい */}
      {prerequisiteSummary && prerequisites && prerequisites.length > 0 && repositoryFullName && (
        <ManualStepPrerequisites
          prerequisites={prerequisites}
          summary={prerequisiteSummary}
          repositoryFullName={repositoryFullName}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {/* 手順を1つずつ案内する入口（#1826）。**実行の前に押すもの**なので、
            終わった後に押すクローズの2つより前に置く */}
        {onStartGuide && (
          <Button size="sm" disabled={isSubmitting} onClick={onStartGuide}>
            <ListChecks />
            順番に進める
          </Button>
        )}
        <Button
          variant={onStartGuide ? "outline" : "default"}
          size="sm"
          disabled={isSubmitting}
          onClick={onComplete}
        >
          {isSubmitting ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          手作業を完了してクローズ
        </Button>
        <Button variant="outline" size="sm" disabled={isSubmitting} onClick={onSkip}>
          <Ban />
          実施せずクローズ
        </Button>
      </div>
    </section>
  );
}
