"use client";

import { Ban, CheckCircle2, Loader2, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 手作業Issue（`71.manual-step`）の詳細画面に出す、実行者向けの案内と出口（#1280）。
 *
 * 手作業Issueは**エージェントへ送らないIssue**でありながら、進捗が`Ready`のまま留まる。
 * そのため以前は「実装を開始」が主ボタンとして出たまま、完了の導線は「…」メニューの
 * 「クローズする」の奥にしか無く、実行し終えたユーザーが次に何をすればよいか画面から
 * 読み取れなかった。ここで「送らないこと」と「終わったらクローズすること」を1か所に出す。
 *
 * 配色にamberを使わないのは、amberが「ユーザーの確認待ち」（`00.check-user`）の色として
 * 使われているため（sidebar-nav・workflow-status-steps）。承認して再開させる先がある
 * 確認待ちと、実行者が人である手作業とを、盤面で混同させない。violetは`71.manual-step`
 * ラベル自体の色（`d876e3`、cross-repo-setup-guide.md）に合わせている。
 */
export function ManualStepPanel({
  onComplete,
  onSkip,
  isSubmitting,
  className,
}: {
  /** 手作業を実行し終えた場合（完了としてクローズ） */
  onComplete: () => void;
  /** 実施せず終わらせる場合（計画外としてクローズ） */
  onSkip: () => void;
  isSubmitting: boolean;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-lg border border-violet-500/40 bg-violet-500/5 p-3",
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
      <p className="mt-2 text-xs text-muted-foreground">
        このIssueはエージェントが代行できない作業です。
        <strong className="font-medium">実装エージェントへは送りません</strong>
        （「開始」ボタンは出しません）。下の説明にある手順を自分で実行してください。
      </p>
      <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
        <li>「前提条件」（デバイス・ディレクトリ・ブランチ・先に必要なIssue／PR）を満たしているか確かめる</li>
        <li>「やること」の手順を実行する</li>
        <li>「完了の確認方法」で効いたことを確かめる</li>
        <li>実行結果や気づいた点があればコメントに残す（任意）</li>
        <li>「手作業を完了してクローズ」を押す</li>
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={isSubmitting} onClick={onComplete}>
          {isSubmitting ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          手作業を完了してクローズ
        </Button>
        <Button variant="outline" size="sm" disabled={isSubmitting} onClick={onSkip}>
          <Ban />
          実施せずクローズ
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        進捗（Status）はReadyのままで構いません。リリースフローには乗らないため、クローズが完了の記録になります。
      </p>
    </section>
  );
}
