"use client";

import {
  FolderGit2,
  GitBranch,
  MessageCircleQuestion,
  Plus,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { DispatchHostPanel } from "@/components/dashboard/dispatch-host-panel";
import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { MobileReloadButton } from "@/components/dashboard/mobile/mobile-reload-button";
import { NavCount, type NavCountEmphasis } from "@/components/dashboard/nav-count";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import {
  navViewIcons,
  sidebarAttentionNavViews,
  sidebarIssueNavViews,
  sidebarQuestionNavViews,
} from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { pullRequestViewIcons, sidebarPullRequestViews } from "@/lib/pull-request-views";
import { getRepoColor } from "@/lib/repo-color";
import type { NavViewId, OverviewStat } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

type MobileHomeScreenProps = {
  /** 先頭の3枚（#1690。要対応・実行中・本番反映待ち） */
  overviewStats: OverviewStat[];
  navCounts: Record<NavViewId, number>;
  /**
   * 「ユーザーの確認待ち」へ一緒に出す、ユーザーのマージ待ちPRの件数（#1690）。
   * PCの左メニュー（`sidebar-nav.tsx`）と同じ数え方にするために受け取る。
   */
  checkUserPullRequestCount: number;
  /** 「ユーザーの作業待ち」の内訳（#1690）。いま実行できるものがあるときだけ強調する */
  manualStepAttention: ManualStepAttention;
  /** PRビューごとの件数（#1389）。nullのビューは件数を出さない */
  pullRequestNavCounts: PullRequestNavCounts;
  onSelectQuickView: (view: NavViewId) => void;
  onSelectPullRequests: (view: PullRequestViewId) => void;
  /** 「ブランチ」画面を開く（#1455）。ビューではないのでメニューへ直接1行として置く */
  onSelectFlow: () => void;
  favoriteRepositories: ConnectedRepository[];
  onSelectRepository: (repository: ConnectedRepository) => void;
  /** 右下の丸ボタン（#1690）。Issue一覧画面と同じ2つを置く */
  onCreateIssue: () => void;
  onAskCrossRepoQuestion: () => void;
  /** 設定画面を開く（#1638。フッターのタブから外し、このヘッダーの歯車が入口になった） */
  onOpenSettings: () => void;
};

/**
 * スマホのホーム画面。
 *
 * **並びは「いまの状況 → メニュー → お気に入りリポジトリ」**（#1690）。先頭のダッシュボードで
 * 盤面とサブPCの様子を掴み、その下のメニューから目的の一覧へ降りる、という読み方にしてある。
 *
 * **メニューはPCの左メニュー（`sidebar-nav.tsx`）と同じ配列・同じ並びを使う。** 以前はここだけ
 * `navViews`から機械的に作った9項目の平坦な一覧で、PCとどちらが正なのか分からない状態だった。
 * 出す項目を決めているのは`lib/nav-views.ts`・`lib/pull-request-views.ts`の`sidebar*`で、
 * 片方を足せば両方に出る。
 *
 * **PCにある「リポジトリ（全件）」「ラベル」は置かない。** リポジトリはフッターの「Issue」タブ
 * （リポジトリ一覧）、ラベルは一覧の絞り込みシートが既に担っており、ホームに3つ目の入口を
 * 作ると押す場所が割れる。
 */
export function MobileHomeScreen({
  overviewStats,
  navCounts,
  checkUserPullRequestCount,
  manualStepAttention,
  pullRequestNavCounts,
  onSelectQuickView,
  onSelectPullRequests,
  onSelectFlow,
  favoriteRepositories,
  onSelectRepository,
  onCreateIssue,
  onAskCrossRepoQuestion,
  onOpenSettings,
}: MobileHomeScreenProps) {
  /*
    ホストの様子（#1690）とヘッダーの実行状況（#1638）の両方が同じ状態を要る。**この画面で1回だけ
    取り、ボタンへは渡す**（#1262）。渡さないとボタンが自前で取りに行き、同じ画面のために
    ポーリングが2本走る。
  */
  const dispatch = useDispatchState(true);
  /*
    実行状況シートの開閉（#1933）。**ヘッダー右上のボタンとサブPCのカードで同じシートを開く**
    ため、状態はここで持つ。開く口が2つになるだけで、中身は1つのまま
  */
  const [dispatchStatusOpen, setDispatchStatusOpen] = useState(false);
  // 確認待ちにはIssueだけでなく、ユーザーがマージするしかないPRも数に含める（PCと同じ）
  const checkUserCount = navCounts["check-user"] + checkUserPullRequestCount;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/*
        ヘッダー右上に実行状況と設定を置く（#1638）。実行状況はどの画面のヘッダーにも同じ
        位置で出すが、**設定はホームだけ**——毎日押すものではないぶんをフッターの1枠から
        降ろした側なので、他の画面のヘッダーまで占領させない
      */}
      <header className="flex shrink-0 items-center gap-1 border-b py-2 pr-2 pl-4">
        <span className="flex-1 text-base font-semibold">Issue Deck</span>
        {/*
          画面の更新（#1681）。PWAにはブラウザの再読み込みが無いので、その代わりを1つだけ
          置く。**ホーム以外の画面には出していない**——理由は`mobile-reload-button.tsx`
        */}
        <MobileReloadButton />
        <MobileDispatchStatusButton
          dispatch={dispatch}
          open={dispatchStatusOpen}
          onOpenChange={setDispatchStatusOpen}
        />
        {/* 通知ベル（#1772）。実行状況の右隣＝PCのトップバー（実行キュー → ベル → アバター）
            と同じ順序。**設定より左**なのは、設定がこの画面だけの右端の常設だから */}
        <MobileNotificationButton />
        <button
          type="button"
          onClick={onOpenSettings}
          title="設定"
          aria-label="設定"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Settings className="size-5" />
        </button>
      </header>

      {/* 最終行が右下の丸ボタンの裏へ入らないよう、下に余白を足す */}
      <div className="flex-1 overflow-y-auto overscroll-contain pb-20">
        {/*
          先頭のダッシュボード（#1690）。盤面の3枚と、サブPCの様子を1枚ずつ。
          ホストの様子はここへ戻したもので、#1638でヘッダーの実行状況シートへ移していた。
          **ホームは使用率だけのサマリ、ヘッダーのシートは動いているセッションとキュー全体
          （順番待ち・失敗・停止操作）**という切り分けにしてある（#1933でセッションの一覧を
          シート側へ寄せ、ホームのカードはシートを開く口を兼ねるようにした）
        */}
        <div className="p-4">
          <h2 className="mb-2 text-sm font-semibold">いまの状況</h2>
          <div className="grid grid-cols-3 gap-2">
            {overviewStats.map((stat) => (
              <button
                key={stat.label}
                type="button"
                onClick={() => onSelectQuickView(stat.linkedView)}
                className="w-full text-left"
              >
                <Card className="gap-1 p-3 hover:bg-accent active:bg-accent">
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <p className="text-lg font-semibold">{stat.value}</p>
                </Card>
              </button>
            ))}
          </div>

          {/*
            サブPCの様子（#1933）。**使用率だけを横並びにした縮めた版**で、動いている
            セッション・スクリプトの版・「更新して再起動」はここには出さず、押して開く
            実行状況シートに任せる。従来はこの1枚だけで縦242pxを占め、メニューの1行目が
            画面の外にあった。申告しているホストが1台も無ければ`DispatchHostPanel`は何も描かない
          */}
          {dispatch.hosts.length > 0 && (
            <div className="mt-2">
              <DispatchHostPanel
                hosts={dispatch.hosts}
                sessions={dispatch.sessions}
                compact
                onOpenDetail={() => setDispatchStatusOpen(true)}
              />
            </div>
          )}
        </div>

        {/*
          人が動くまで進まないもの（#1613と同じ枠）。PCと同じく見出しを付けずメニューの
          最上段に固定する。ここに他のビューを足すと、上から順に手を動かせば盤面が進む、
          という読み方が崩れる
        */}
        <div className="px-4 pb-4">
          <ul className="flex flex-col gap-1">
            {sidebarAttentionNavViews.map((view) => (
              <MobileNavRow
                key={view.id}
                label={view.label}
                icon={navViewIcons[view.id]}
                onClick={() => onSelectQuickView(view.id)}
                count={view.id === "check-user" ? checkUserCount : navCounts[view.id]}
                // 確認待ちは残っている限り強調する（#742）。手作業はいま実行できるものが
                // あるときだけで、前提待ちしか無い間は強調しない（#1613）
                emphasis={
                  (
                    view.id === "check-user"
                      ? checkUserCount > 0
                      : manualStepAttention.actionable > 0
                  )
                    ? "attention"
                    : "none"
                }
              />
            ))}
          </ul>

          <Separator className="my-2" />

          <ul className="flex flex-col gap-1">
            {sidebarQuestionNavViews.map((view) => (
              <MobileNavRow
                key={view.id}
                label={view.label}
                icon={navViewIcons[view.id]}
                onClick={() => onSelectQuickView(view.id)}
                // 件数は未確認（回答が届いていて未読）の数で、確認待ち・作業待ちと同じく
                // 「いま手を動かせる数」を出す（#1910・PCと同じ）
                count={navCounts[view.id]}
                emphasis={navCounts[view.id] > 0 ? "attention" : "none"}
                title={
                  navCounts[view.id] > 0
                    ? `回答が届いていてまだ開いていない質問が${navCounts[view.id]}件あります`
                    : undefined
                }
              />
            ))}
            <MobileNavRow label="ブランチ" icon={GitBranch} onClick={onSelectFlow} />
          </ul>
        </div>

        <div className="px-4 pb-4">
          <h2 className="mb-2 text-sm font-semibold">Issue</h2>
          <ul className="flex flex-col gap-1">
            {sidebarIssueNavViews.map((view) => (
              <MobileNavRow
                key={view.id}
                label={view.label}
                icon={navViewIcons[view.id]}
                onClick={() => onSelectQuickView(view.id)}
                count={navCounts[view.id]}
              />
            ))}
          </ul>
        </div>

        <div className="px-4 pb-4">
          <h2 className="mb-2 text-sm font-semibold">Pull Request</h2>
          <ul className="flex flex-col gap-1">
            {sidebarPullRequestViews.map((view) => (
              <MobileNavRow
                key={view.id}
                label={view.label}
                icon={pullRequestViewIcons[view.id]}
                onClick={() => onSelectPullRequests(view.id)}
                count={pullRequestNavCounts[view.id]}
              />
            ))}
          </ul>
        </div>

        {favoriteRepositories.length > 0 && (
          <div className="px-4 pb-4">
            <h2 className="mb-2 text-sm font-semibold">お気に入りリポジトリ</h2>
            <ul className="flex flex-col gap-1">
              {favoriteRepositories.map((repo) => {
                const color = getRepoColor(repo.fullName);
                return (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => onSelectRepository(repo)}
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
                    >
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        <FolderGit2 className="size-3.5" />
                      </span>
                      <span className="truncate">{repo.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/*
        Issue一覧画面（`mobile-issue-list-screen.tsx`）と**同じ形・同じ順**の丸ボタン（#1690）。
        同じ動作のボタンが画面ごとに違う見た目・違う位置にあると探すことになる。位置だけは違い、
        あちらは下端の絞り込み行を避けて上げているが、ホームにその行は無いのでフッターのすぐ上。
        z-20も揃える（#1945）。一覧に重ねたときに行の後ろへ回らないようにするため
      */}
      <div className="absolute right-4 bottom-4 z-20 flex items-center gap-3">
        <button
          type="button"
          onClick={onAskCrossRepoQuestion}
          aria-label="複数リポジトリに質問する"
          className="flex size-14 items-center justify-center rounded-full border bg-background shadow-lg"
        >
          <MessageCircleQuestion className="size-6" />
        </button>
        <button
          type="button"
          onClick={onCreateIssue}
          aria-label="新しいIssueを作成"
          className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
        >
          <Plus className="size-6" />
        </button>
      </div>
    </div>
  );
}

/**
 * メニューの1行。**見た目はPCの`sidebar-nav.tsx`の`navRow`と揃え、高さだけスマホの
 * タップ領域（44px）に合わせる。** 選択中の表示は持たない——ホームは現在地ではなく
 * 入口の一覧で、押せばその画面へ遷移して離れるため。
 */
function MobileNavRow({
  label,
  icon: Icon,
  onClick,
  count,
  emphasis = "none",
  title,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** null・未指定なら件数を出さない */
  count?: number | null;
  /** 件数の強調（`NavCount`。左メニューと同じ使い分け） */
  emphasis?: NavCountEmphasis;
  title?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
      >
        <span className="flex items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          {label}
        </span>
        {/* 強調の使い分けと見た目は`NavCount`（PCの左メニューと共通） */}
        <NavCount count={count} emphasis={emphasis} />
      </button>
    </li>
  );
}
