"use client";

import {
  FolderGit2,
  GitBranch,
  MessageCircleQuestion,
  Plus,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  CompactHostCardSkeleton,
  DispatchHostPanel,
} from "@/components/dashboard/dispatch-host-panel";
import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { MobileReloadButton } from "@/components/dashboard/mobile/mobile-reload-button";
import { NavCount, type NavCountEmphasis } from "@/components/dashboard/nav-count";
import { useNotificationState } from "@/components/dashboard/notification-state";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import { formatQuestionNavTitle } from "@/lib/question-attention";
import {
  navViewIcons,
  sidebarAttentionNavViews,
  sidebarIssueNavViews,
  sidebarQuestionNavViews,
} from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { pullRequestViewIcons, sidebarPullRequestViews } from "@/lib/pull-request-views";
import { describeReleaseActivity, type ReleaseActivityCounts } from "@/lib/release-activity";
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
  /**
   * 未確認（回答が届いていて未読）の質問の件数（#2070）。**行に出す数字は`navCounts`から
   * 引き、これは使わない**——オレンジの丸を点けるかどうかと、吹き出しの内訳だけに使う。
   */
  unconfirmedQuestionCount: number;
  /**
   * リリース・デプロイが動いているリポジトリ数（#2167）。「ブランチ」行の件数とオレンジの丸に
   * 使う。**nullは未取得**で、そのときは件数を出さない。PCの左メニューと同じ数え方。
   */
  releaseActivity: ReleaseActivityCounts | null;
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
  /**
   * 下へ引っ張ったときの取り直し（#2182）。渡さない画面では引っ張って更新を有効にしない。
   * 渡すのはベルの更新ボタンと同じ`useNotificationState`の`refresh`で、ホームに出ている
   * 数字の材料（リリース状況・Issue一覧・PR一覧）をまとめて取り直す。
   */
  onRefresh?: () => void;
  /**
   * 上の取り直しが飛んでいる間（#2182）。**`onRefresh`は取り直しの合図を出すだけの同期関数で
   * 完了を待てない**ため、これを渡して「更新中…」を保つ（ブランチ画面と同じ形。#1958）。
   */
  isRefreshing?: boolean;
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
 *
 * **「ブランチ」行の件数はProviderから自分で読む**（#2167。`MobileBottomNav`・PCの左メニューと
 * 同じ形）。材料はベルと同じ1本のポーリングで、この画面を描いている`issue-deck-shell.tsx`は
 * `NotificationProvider`の親なのでフックを呼べず、propで配れない。
 */
export function MobileHomeScreen(
  props: Omit<MobileHomeScreenProps, "releaseActivity" | "onRefresh" | "isRefreshing">,
) {
  /*
    引っ張って更新（#2182）もここから配る。**ベル右上の「更新」ボタンと同じ`refresh`**で、
    ホームに出ている数字の材料（リリース状況・Issue一覧・PR一覧）をまとめて取り直せるのは
    ここだけ。取り直しの完了は待てない同期関数なので、`isFetching`を併せて渡す
  */
  const { releaseActivity, refresh, isFetching } = useNotificationState();

  return (
    <MobileHomeScreenView
      {...props}
      releaseActivity={releaseActivity}
      onRefresh={refresh}
      isRefreshing={isFetching}
    />
  );
}

/**
 * 描画だけを持つ本体。Providerに依存しないので、件数を渡してそのまま試験できる。
 */
export function MobileHomeScreenView({
  overviewStats,
  navCounts,
  checkUserPullRequestCount,
  manualStepAttention,
  unconfirmedQuestionCount,
  releaseActivity,
  pullRequestNavCounts,
  onSelectQuickView,
  onSelectPullRequests,
  onSelectFlow,
  favoriteRepositories,
  onSelectRepository,
  onCreateIssue,
  onAskCrossRepoQuestion,
  onOpenSettings,
  onRefresh,
  isRefreshing,
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

  /*
    下へ引っ張って更新（#2182）。タッチを受けるのはスクロール領域を包む枠で、スクロール位置は
    中のスクロール領域から見る（Issue一覧・ブランチ画面と同じ組み方）。

    **サブPCのカードの取り直し（`dispatch.refresh`）はここで足す。** 実行状況はこの画面が
    自分で取っているもので、ベルの`refresh`には入っていない。ホームに出ているものは全部
    新しくなる、という一つの操作にする
  */
  const pullContainerRef = useRef<HTMLDivElement>(null);
  const pullScrollRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({
    containerRef: pullContainerRef,
    scrollRef: pullScrollRef,
    onRefresh: onRefresh
      ? () => {
          dispatch.refresh();
          onRefresh();
        }
      : undefined,
    isRefreshing,
  });

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

      {/* 引っ張って更新（#2182）のタッチを受ける枠。スクロールするのは中の要素で、この枠は
          動かない（インジケーターを上端に重ねる基準にもなる） */}
      <div ref={pullContainerRef} className="relative flex min-h-0 flex-1 flex-col">
        <PullToRefreshIndicator pull={pull} />

        {/* 最終行が右下の丸ボタンの裏へ入らないよう、下に余白を足す */}
        <div
          ref={pullScrollRef}
          className="flex-1 overflow-y-auto overscroll-contain pb-20"
          style={{
            // 引っ張った量だけ中身を下げる。指の動きには追従させ、離した後の戻りだけ
            // アニメーションさせる（インジケーターの高さと同じ扱い）
            transform: pull.distance > 0 ? `translateY(${pull.distance}px)` : undefined,
            transition: pull.isDragging ? "none" : "transform 0.2s ease-out",
          }}
        >
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
              画面の外にあった。

              出し分けは3通り（#2090）。**最初の取得が終わるまでは同じ高さのスケルトン**、
              終わって申告しているホストがいればカード、いなければ何も描かない。`hosts`は取得前も
              `[]`なので、スケルトンが無いと届くまでカードごと消え、下のメニューがカード1枚ぶん
              繰り上がる。届いた瞬間に全部が下へ落ちるため、開いてすぐ押した指が別の行に当たる。
              出すのは`isLoaded`が立つまでの1回だけで、20秒ごとの取り直しでは出さない
              （出すと20秒おきにカードが灰色に戻る）。枚数が1枚なのは、台数が取得するまで
              分からないため——いま申告しているのはサブPC1台。

              **取得に失敗しても`isLoaded`は立ち、スケルトンは消える**（計画レビュー指摘2）。
              失敗は表面化しない作りなので、残すと「読み込み中」の顔のまま止まって見える。
              読み込み中と読み込めなかったを見分けられるようにする（#1978）方針に合わせ、
              失敗したときは従来どおり何も出ない状態へ落とし、20秒後の取り直しに任せる
            */}
            {!dispatch.isLoaded ? (
              <div className="mt-2">
                <CompactHostCardSkeleton />
              </div>
            ) : (
              dispatch.hosts.length > 0 && (
                <div className="mt-2">
                  <DispatchHostPanel
                    hosts={dispatch.hosts}
                    sessions={dispatch.sessions}
                    compact
                    onOpenDetail={() => setDispatchStatusOpen(true)}
                  />
                </div>
              )
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
                  // 件数は一覧に並ぶ数（＝開いている質問の総数）に揃える（#2070・PCと同じ）。
                  // 「いま読める回答がある」という#1910の合図はオレンジの丸として残す
                  count={navCounts[view.id]}
                  emphasis={unconfirmedQuestionCount > 0 ? "attention" : "none"}
                  title={formatQuestionNavTitle(navCounts[view.id], unconfirmedQuestionCount)}
                />
              ))}
              {/* 件数の意味と数え方はPCの左メニュー（`sidebar-nav.tsx`）と同じ（#2167）。
                  リリース・デプロイが動いているプロジェクト数を出し、人が操作するまで進まない
                  ものがあるときだけオレンジの丸にする。手作業は含めない */}
              <MobileNavRow
                label="ブランチ"
                icon={GitBranch}
                onClick={onSelectFlow}
                count={releaseActivity?.total ?? null}
                emphasis={(releaseActivity?.actionRequired ?? 0) > 0 ? "attention" : "none"}
                title={describeReleaseActivity(releaseActivity)}
              />
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
