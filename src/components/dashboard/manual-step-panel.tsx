"use client";

import { Ban, BadgeCheck, CheckCircle2, GitBranch, ListChecks, Loader2, Wrench } from "lucide-react";

import { IssueDependents } from "@/components/dashboard/issue-dependents";
import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import type { IssueDependent } from "@/lib/issue-dependents";
import type { InfraConfigTarget } from "@/lib/infra-config-repos";
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
  dependents,
  verifiedAt,
  configTargets,
  onCreateConfigIssue,
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
  /**
   * このIssueの完了を待っているIssue（#2003）。**実行者に一番効く情報**——自分が終わるまで
   * 何が止まっているのかが分かると、後回しにしてよい手作業かどうかを判断できる。
   */
  dependents?: IssueDependent[];
  /**
   * 定期巡回で`## 完了の確認方法`のコマンドがすべて通った日時（ISO8601。#2008）。
   * 通っていない・巡回の対象外はnullで、そのときは何も出さない。
   */
  verifiedAt?: string | null;
  /**
   * 実機のファイルを書き換える手順のうち、`guchi-apps/vps`・`guchi-apps/subpc`で管理されて
   * いるもの（#2021）。`lib/infra-config-repos.ts`の検出結果をそのまま渡す。
   */
  configTargets?: InfraConfigTarget[];
  /** 上記を対象リポジトリのIssueとして切り出す。渡さない場合は案内ごと出さない */
  onCreateConfigIssue?: (target: InfraConfigTarget) => void;
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
      {/* 逆向き——この手作業が終わるまで先へ進めないIssue（#2003）。前提条件のすぐ下に置く。
          どちらも実施順序という1つの問いへの答えで、離すと順番を確かめるのに画面を往復する */}
      {dependents && dependents.length > 0 && repositoryFullName && (
        <IssueDependents dependents={dependents} repositoryFullName={repositoryFullName} />
      )}
      {/* 実機を直接書き換える手順は、リポジトリ経由へ寄せられる（#2021）。**実行の前に
          気付いてほしい**ので、「順番に進める」より上に置く */}
      {onCreateConfigIssue && configTargets && configTargets.length > 0 && (
        <InfraConfigNotice
          targets={configTargets}
          onCreate={onCreateConfigIssue}
          isSubmitting={isSubmitting}
        />
      )}
      {verifiedAt && <ManualStepVerifiedNotice verifiedAt={verifiedAt} />}
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
          // 確認が通っているときは、押してほしいのがクローズになる（#2008）。実行の入口
          // （「順番に進める」）より、こちらを主ボタンにする
          variant={onStartGuide && !verifiedAt ? "outline" : "default"}
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

/**
 * 定期巡回で完了の確認コマンドが通ったことを伝える（#2008）。
 *
 * **「完了済みの可能性」までしか言わない。** 巡回が見ているのは終了コードだけで、本文の
 * 「期待する出力」との照合はしていない（`lib/manual-step-verification.ts`）。断定すると、
 * 通っただけのものを確かめずにクローズしてしまう。
 *
 * **出力そのものはここに出さない。** 手作業の出力にはシークレットが混ざりうるため、置き場は
 * 実行キューのジョブ1か所に留める（#1828「出力は画面にだけ出す」）。
 */
function ManualStepVerifiedNotice({ verifiedAt }: { verifiedAt: string }) {
  return (
    <p
      className="flex items-start gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300"
      title={formatDateTimeFull(verifiedAt)}
    >
      <BadgeCheck className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium">完了済みの可能性があります。</span>
        {/* 日本語の地の文なので、行を分けてできる空白が入らないよう1つの文字列にまとめる */}
        {`${formatDateTime(verifiedAt)}の巡回で「完了の確認方法」のコマンドがすべて成功しました。` +
          "出力の中身までは照合していないため、確かめてからクローズしてください。"}
      </span>
    </p>
  );
}

/**
 * 実機のファイル変更を、管理リポジトリのIssueへ切り出す入口（#2021）。
 *
 * VPS・サブPCの設定ファイルは`guchi-apps/vps`・`guchi-apps/subpc`で管理されており、
 * mainへマージすれば実機へ自動で反映される。**手で書き換えるとGitに残らずドリフトになる**
 * ため、当たっている手順があるときだけ、切り出す導線をここに出す。
 *
 * **押しても勝手に起票しない。** 押すと新規作成ダイアログが対象リポジトリ・タイトル・本文を
 * 埋めた状態で開くだけで、作るかどうかは中身を読んだ人が決める（他リポジトリへ書く操作を
 * 画面が黙って行わない）。
 *
 * **手作業を止めない。** 検出はパスの文字列一致だけの推定で、外していることもある。
 * 実行の導線（「順番に進める」「完了してクローズ」）はそのまま押せる状態で残す。
 */
function InfraConfigNotice({
  targets,
  onCreate,
  isSubmitting,
}: {
  targets: InfraConfigTarget[];
  onCreate: (target: InfraConfigTarget) => void;
  isSubmitting: boolean;
}) {
  return (
    <section className="rounded-md border bg-background p-2.5" aria-labelledby="manual-step-config-title">
      <p id="manual-step-config-title" className="text-xs font-medium">
        リポジトリ経由で反映できます
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        実機のファイルを書き換える手順があります。これらはGitで管理されていて、PRをマージすれば実機へ自動で反映されます。
      </p>
      <ul className="mt-2 space-y-2">
        {targets.map((target) => (
          <li
            key={`${target.repo.repositoryFullName}:${target.entry.repoPath}:${target.line ?? target.stepText}`}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span className="text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1 py-px">{target.entry.livePath}</code>
              {" → "}
              <code className="rounded bg-muted px-1 py-px">
                {target.repo.repositoryFullName}
              </code>
              {" の "}
              <code className="rounded bg-muted px-1 py-px">{target.entry.repoPath}</code>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={() => onCreate(target)}
            >
              <GitBranch />
              設定変更Issueを作る
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
