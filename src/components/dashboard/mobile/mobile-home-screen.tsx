"use client";

import {
  CalendarClock,
  FolderGit2,
  Loader2,
  Lightbulb,
  MessageSquareText,
  Smartphone,
  MonitorPlay,
  Rocket,
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
import type { NavCountEmphasis } from "@/components/dashboard/nav-count";
import { useNotificationState } from "@/components/dashboard/notification-state";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { Separator } from "@/components/ui/separator";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import { resolveQuestionNavSignals } from "@/lib/question-attention";
import {
  navViewIcons,
  sidebarAttentionNavViews,
  sidebarCodeReviewNavViews,
  sidebarIssueNavViews,
  sidebarQuestionNavViews,
  PREVIEW_NAV_VISIBLE,
} from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import {
  describeMergePendingAttention,
  isPullRequestViewAttention,
  type MergePendingAttention,
} from "@/lib/merge-pending-attention";
import { pullRequestViewIcons, sidebarPullRequestViews } from "@/lib/pull-request-views";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

type MobileHomeScreenProps = {
  /**
   * ビューごとの件数。**「ユーザーの確認待ち」は、マージ待ちPRの対応Issueを除いた数を渡す**
   * （#3650。マージ待ちは「マージ待ち」のタイルで見る。除く規則は`mergePendingIssueKeys`）
   */
  navCounts: Record<NavViewId, number>;
  /** 「ユーザーの作業待ち」の内訳（#1690）。いま実行できるものがあるときだけ強調する */
  manualStepAttention: ManualStepAttention;
  /**
   * 未確認（回答が届いていて未読）の質問の件数（#2070）。**行に出す数字は`navCounts`から
   * 引き、これは使わない**——オレンジの丸を点けるかどうかと、吹き出しの内訳だけに使う。
   */
  unconfirmedQuestionCount: number;
  /**
   * 回答待ち（質問を投げてまだ回答が届いていない）の質問の件数（#2309）。**「質問」の行の
   * スピナーを回すかどうかと、吹き出しの内訳に使う。行に出す数字はこれまでどおり`navCounts`。**
   */
  waitingQuestionCount: number;
  /** PRビューごとの件数（#1389）。nullのビューは件数を出さない */
  pullRequestNavCounts: PullRequestNavCounts;
  /**
   * 「マージ待ち」の内訳（#2334・PCの左メニューと同じ使い分け）。行に出す数字は
   * `pullRequestNavCounts`から引き、これはオレンジの丸と吹き出しにだけ使う
   */
  mergePendingAttention: MergePendingAttention | null;
  onSelectQuickView: (view: NavViewId) => void;
  onSelectPullRequests: (view: PullRequestViewId) => void;
  /** 「確認環境」画面を開く（#2444）。ビューではないのでメニューへ直接1行として置く */
  onSelectPreview: () => void;
  /**
   * 確認環境が動いているか（#2444）。動いている間だけオレンジの丸を出す。
   * **外出先でこそ効く**——押し忘れて置きっぱなしのものが、ホームを開いただけで分かる。
   */
  previewRunning: boolean;
  /** 「予約実行」画面を開く（#2995）。「確認環境」と同じくメニューへ直接1行として置く */
  onSelectNightlyRun: () => void;
  /** 次の5時間枠に積んであるIssueの数（#2995）。行に出す */
  nightlyRunQueuedCount: number | null;
  /** 構想の件数（#3639）。取得できていないときはnull */
  ideasCount?: number | null;
  /** 新規アプリの構想一覧を開く */
  onSelectIdeas?: () => void;
  onSelectChat?: () => void;
  /** iOS拡張（#3708）の画面を開く */
  onSelectIosExtensions?: () => void;
  /**
   * リポジトリ一覧の画面を開く（#2724。フッターの「Issue」タブを外した代わりの入口）。
   * 「ブランチ」「確認環境」と同じくビューではないので、メニューへ直接1行として置く
   */
  onSelectRepos: () => void;
  /** 連携しているリポジトリの数（#2724）。「リポジトリ」の行に出す */
  repositoryCount: number;
  favoriteRepositories: ConnectedRepository[];
  onSelectRepository: (repository: ConnectedRepository) => void;
  /**
   * 新規アプリの立ち上げ（#2188）。**メニューの最後に1行だけ置き、丸ボタンは増やさない**——
   * 使うのは年に数回で、いちばん使うIssue作成の導線を1タップ遠くしないため。
   */
  onLaunchNewApp: () => void;
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
 * **並びは「サブPCの様子 → 件数のタイル（要確認・進行・一覧）→ お気に入りリポジトリ」**（#3650）。
 * 縦一列のリストでは「マージ待ち」「予約実行」が1画面目の外へ出ていたため、2列のタイルにした。
 *
 * **出す項目はPCの左メニュー（`sidebar-nav.tsx`）と同じ`sidebar*`の配列から取るが、並びはPCと
 * 揃えない**（#3650）。グループと順序は`HOME_TILE_LAYOUT`の1か所で決め、そこに無い項目は「一覧」
 * の末尾へ出る。**「確認待ち」の件数にマージ待ちPRは含めない**——マージ待ちは「マージ待ち」の
 * タイルで見る（呼び出し側が除いた`navCounts`を渡す）。
 *
 * **リポジトリは1行だけ置き、ラベルは置かない**（#2724）。リポジトリ一覧はフッターの「Issue」
 * タブが担っていたが、そのタブを外したのでここが唯一の入口になった（PCの左メニューのように
 * 全リポジトリを展開はせず、一覧画面へ渡す1行にとどめる）。ラベルは一覧の絞り込みシートが
 * 既に担っており、ホームに2つ目の入口を作ると押す場所が割れる。置く位置は「コードレビュー」の
 * 直上（#2737。下記参照）。
 *
 * **「ブランチ」行はここには置かない**（#2737）。フッターに常設の「ブランチ」タブ
 * （`mobile-bottom-nav.tsx`）があり同じ画面を開けるため、ホームのメニューには重複して出さない。
 * **PCの左メニュー（`sidebar-nav.tsx`）にはフッターが無く「ブランチ」の唯一の入口なので、
 * そちらには残す**——このためスマホとPCのメニューはこの1行分だけ並びが一致しない。
 */
export function MobileHomeScreen(props: Omit<MobileHomeScreenProps, "onRefresh" | "isRefreshing">) {
  /*
    引っ張って更新（#2182）もここから配る。**ベル右上の「更新」ボタンと同じ`refresh`**で、
    ホームに出ている数字の材料（リリース状況・Issue一覧・PR一覧）をまとめて取り直せるのは
    ここだけ。取り直しの完了は待てない同期関数なので、`isFetching`を併せて渡す
  */
  const { refresh, isFetching } = useNotificationState();

  return (
    <MobileHomeScreenView
      {...props}
      onRefresh={refresh}
      isRefreshing={isFetching}
    />
  );
}

/**
 * 描画だけを持つ本体。Providerに依存しないので、件数を渡してそのまま試験できる。
 */
export function MobileHomeScreenView({
  navCounts,
  manualStepAttention,
  unconfirmedQuestionCount,
  waitingQuestionCount,
  pullRequestNavCounts,
  mergePendingAttention,
  onSelectQuickView,
  onSelectPullRequests,
  onSelectPreview,
  previewRunning,
  onSelectNightlyRun,
  nightlyRunQueuedCount,
  ideasCount = null,
  onSelectIdeas = () => {},
  onSelectChat = () => {},
  onSelectIosExtensions = () => {},
  onSelectRepos,
  repositoryCount,
  favoriteRepositories,
  onSelectRepository,
  onLaunchNewApp,
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
  // 確認待ちはIssueの確認待ち（計画待ちなど）だけを数える。マージ待ちは別のタイルで見る（#3650）
  const checkUserCount = navCounts["check-user"];
  const tiles = buildHomeTiles({
    navCounts,
    checkUserCount,
    manualStepAttention,
    unconfirmedQuestionCount,
    waitingQuestionCount,
    pullRequestNavCounts,
    mergePendingAttention,
    previewRunning,
    nightlyRunQueuedCount,
    ideasCount,
    repositoryCount,
    onSelectQuickView,
    onSelectPullRequests,
    onSelectPreview,
    onSelectNightlyRun,
    onSelectIdeas,
    onSelectChat,
    onSelectIosExtensions,
    onSelectRepos,
  });

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
      {/* `overflow-hidden`は引っ張ったぶんのはみ出しを切り抜くため（#2885。理由は
          `issue-list.tsx`の同じ枠のコメントを参照） */}
      <div ref={pullContainerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
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
            先頭のサブPCの様子（#1690）。盤面の件数は下のタイルへ統合した（#3650）。
            ホストの様子はここへ戻したもので、#1638でヘッダーの実行状況シートへ移していた。
            **ホームは使用率だけのサマリ、ヘッダーのシートは動いているセッションとキュー全体
            （順番待ち・失敗・停止操作）**という切り分けにしてある（#1933でセッションの一覧を
            シート側へ寄せ、ホームのカードはシートを開く口を兼ねるようにした）
          */}
          <div className="p-4">
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
            件数のタイル（#3650）。**縦一列のリストでは「マージ待ち」「予約実行」が1画面目の外へ
            出ていた**ため、2列のタイルにして1画面で件数が読めるようにした。並びは要確認（人が
            動くまで進まないもの）→進行→一覧。グループ分けは`HOME_TILE_LAYOUT`の1か所で決める
          */}
          {HOME_TILE_GROUPS.map((group) => {
            const groupTiles = tiles.filter((tile) => tile.group === group.id);
            if (groupTiles.length === 0) return null;
            return (
              <div key={group.id} className="px-4 pb-3">
                <h2 className="mb-2 text-sm font-semibold">{group.label}</h2>
                <ul className="grid grid-cols-2 gap-2">
                  {groupTiles.map((tile) => (
                    <HomeTile key={tile.key} tile={tile} />
                  ))}
                </ul>
              </div>
            );
          })}

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

          {/*
            新規アプリの立ち上げ（#2188）。PCの左メニュー（`sidebar-nav.tsx`）と同じく
            **最下部に1行だけ**置く。丸ボタン（FAB）は「質問」「Issue作成」の2つのまま増やさない
          */}
          <div className="px-4 pb-4">
            <Separator className="mb-2" />
            <button
              type="button"
              onClick={onLaunchNewApp}
              title="リポジトリの作成と、残りの作業のIssue起票までを行う"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
            >
              <Rocket className="size-3.5 shrink-0 text-muted-foreground" />
              新規アプリを立ち上げる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


type HomeTileGroupId = "attention" | "progress" | "list";

/** タイルのグループ（#3650）。見出しの文言と並び順 */
const HOME_TILE_GROUPS: { id: HomeTileGroupId; label: string }[] = [
  { id: "attention", label: "要確認" },
  { id: "progress", label: "進行" },
  { id: "list", label: "一覧" },
];

/**
 * どのタイルをどのグループのどの順に置くか（#3650）。**組み直しの規則はここの1か所だけ**。
 * キーはIssueのビューid、PRのビューは`pr:<id>`、ビューでないものは下の`buildHomeTiles`が付ける名前。
 * ここに無いものは「一覧」の末尾に出る——`sidebar*`の配列へ項目を足しても、スマホで
 * 出なくなることはない（PCと同じ並びに揃える約束は#3650で外した）。
 */
const HOME_TILE_LAYOUT: Record<HomeTileGroupId, string[]> = {
  attention: ["check-user", "manual-step", "pr:completed", "question"],
  progress: ["not-started", "nightly-run", "in-progress", "pr:in-progress", "release-pending"],
  list: ["all", "pr:all", "repos", "code-review", "chat", "ideas", "ios-extensions", "preview"],
};

type HomeTile = {
  key: string;
  group: HomeTileGroupId;
  label: string;
  icon: LucideIcon;
  count: number | null;
  emphasis: NavCountEmphasis;
  busy: boolean;
  title?: string;
  onClick: () => void;
};

function resolveTileGroup(key: string): { group: HomeTileGroupId; rank: number } {
  for (const group of HOME_TILE_GROUPS) {
    const rank = HOME_TILE_LAYOUT[group.id].indexOf(key);
    if (rank >= 0) return { group: group.id, rank };
  }
  return { group: "list", rank: Number.MAX_SAFE_INTEGER };
}

type BuildHomeTilesInput = {
  navCounts: Record<NavViewId, number>;
  checkUserCount: number;
  manualStepAttention: ManualStepAttention;
  unconfirmedQuestionCount: number;
  waitingQuestionCount: number;
  pullRequestNavCounts: PullRequestNavCounts;
  mergePendingAttention: MergePendingAttention | null;
  previewRunning: boolean;
  nightlyRunQueuedCount: number | null;
  ideasCount: number | null;
  repositoryCount: number;
  onSelectQuickView: (view: NavViewId) => void;
  onSelectPullRequests: (view: PullRequestViewId) => void;
  onSelectPreview: () => void;
  onSelectNightlyRun: () => void;
  onSelectIdeas: () => void;
  onSelectChat: () => void;
  onSelectIosExtensions: () => void;
  onSelectRepos: () => void;
};

/**
 * ホームに出すタイルを組み立てる（#3650）。出す項目の判定はPCの左メニューと同じ`sidebar*`の
 * 配列から取り、グループと順序だけをこの画面の`HOME_TILE_LAYOUT`で決める。
 * **PRの「実行中」は見出しが無くなってもIssueの「実行中」と区別できるよう「PR実行中」と出す。**
 */
function buildHomeTiles(input: BuildHomeTilesInput): HomeTile[] {
  const tiles: Omit<HomeTile, "group">[] = [];

  for (const view of sidebarAttentionNavViews) {
    tiles.push({
      key: view.id,
      label: view.label,
      icon: navViewIcons[view.id],
      count: view.id === "check-user" ? input.checkUserCount : input.navCounts[view.id],
      // 確認待ちは残っている限り強調する（#742）。手作業はいま実行できるものがあるときだけで、
      // 前提待ちしか無い間は強調しない（#1613）
      emphasis: (
        view.id === "check-user"
          ? input.checkUserCount > 0
          : input.manualStepAttention.actionable > 0
      )
        ? "attention"
        : "none",
      busy: false,
      onClick: () => input.onSelectQuickView(view.id),
    });
  }

  // 質問・コードレビューは合図を行ごとに決める（#2325・PCと同じ`resolveQuestionNavSignals`）
  for (const view of [...sidebarQuestionNavViews, ...sidebarCodeReviewNavViews]) {
    const signals = resolveQuestionNavSignals(view.id, {
      total: input.navCounts.question,
      unconfirmed: input.unconfirmedQuestionCount,
      waiting: input.waitingQuestionCount,
    });
    tiles.push({
      key: view.id,
      label: view.label,
      icon: navViewIcons[view.id],
      // 件数は一覧に並ぶ数（＝開いている質問の総数）に揃える（#2070・PCと同じ）
      count: input.navCounts[view.id],
      emphasis: signals.attention ? "attention" : "none",
      busy: signals.busy,
      title: signals.title,
      onClick: () => input.onSelectQuickView(view.id),
    });
  }

  for (const view of sidebarIssueNavViews) {
    tiles.push({
      key: view.id,
      label: view.label,
      icon: navViewIcons[view.id],
      count: input.navCounts[view.id],
      emphasis: "none",
      busy: false,
      onClick: () => input.onSelectQuickView(view.id),
    });
  }

  for (const view of sidebarPullRequestViews) {
    tiles.push({
      key: `pr:${view.id}`,
      label: view.id === "in-progress" ? "PR実行中" : view.label,
      icon: pullRequestViewIcons[view.id],
      count: input.pullRequestNavCounts[view.id],
      // 「マージ待ち」のうち人が手を動かすまで進まないものが残っているときだけオレンジの丸に
      // する（#2334・PCの左メニューと同じ`isPullRequestViewAttention`）
      emphasis: isPullRequestViewAttention(view.id, input.mergePendingAttention)
        ? "attention"
        : "none",
      busy: false,
      title:
        view.id === "completed"
          ? describeMergePendingAttention(view.description, input.mergePendingAttention)
          : undefined,
      onClick: () => input.onSelectPullRequests(view.id),
    });
  }

  // リポジトリ一覧（#2724）。フッターの「Issue」タブを外した代わりの入口。件数は連携している数
  tiles.push({
    key: "repos",
    label: "リポジトリ",
    icon: FolderGit2,
    count: input.repositoryCount,
    emphasis: "none",
    busy: false,
    title: "リポジトリを選んで、そのリポジトリのIssue一覧を開く",
    onClick: input.onSelectRepos,
  });

  // 確認環境（#2444）。件数は出さず、動いていることをオレンジの丸で出す
  if (PREVIEW_NAV_VISIBLE) {
    tiles.push({
      key: "preview",
      label: "確認環境",
      icon: MonitorPlay,
      count: null,
      emphasis: input.previewRunning ? "attention" : "none",
      busy: false,
      title: input.previewRunning
        ? "確認環境が動いています"
        : "developの最新をサブPCで動かして画面で確かめる",
      onClick: input.onSelectPreview,
    });
  }

  tiles.push(
    {
      key: "nightly-run",
      label: "予約実行",
      icon: CalendarClock,
      count: input.nightlyRunQueuedCount,
      emphasis: "none",
      busy: false,
      title: "次の5時間枠の予定、直近の結果を見る",
      onClick: input.onSelectNightlyRun,
    },
    {
      key: "ideas",
      label: "構想",
      icon: Lightbulb,
      count: input.ideasCount,
      emphasis: "none",
      busy: false,
      title: "新規アプリの構想を確認・整理する",
      onClick: input.onSelectIdeas,
    },
    {
      key: "chat",
      label: "チャット",
      icon: MessageSquareText,
      count: null,
      emphasis: "none",
      busy: false,
      title: "Issue・PRの状態確認や修復を会話で進める",
      onClick: input.onSelectChat,
    },
    {
      key: "ios-extensions",
      label: "iOS拡張",
      icon: Smartphone,
      count: null,
      emphasis: "none",
      busy: false,
      title: "ウィジェット・ロック画面・ライブアクティビティ・コントロールを一覧する",
      onClick: input.onSelectIosExtensions,
    },
  );

  return tiles
    .map((tile) => ({ ...tile, ...resolveTileGroup(tile.key) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...tile }) => tile);
}

/**
 * ホームのタイル1枚。**強調の使い分けは`NavCount`（PCの左メニュー）と揃える**——オレンジの丸は
 * 「人が手を動かすまで進まないもの」の合図で、数字の見た目だけを大きくしてある。
 * 選択中の表示は持たない（押せばその画面へ遷移して離れるため）。
 */
function HomeTile({ tile }: { tile: HomeTile }) {
  const Icon = tile.icon;
  return (
    <li>
      <button
        type="button"
        onClick={tile.onClick}
        title={tile.title}
        className={cn(
          "flex min-h-16 w-full flex-col justify-between gap-1 rounded-xl border bg-card px-3 py-2.5 text-left hover:bg-accent active:bg-accent",
          tile.emphasis === "attention" && "border-amber-500/50 bg-amber-500/10",
        )}
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{tile.label}</span>
          {tile.busy && <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />}
        </span>
        {tile.count !== null && (
          <span
            className={cn(
              "text-xl leading-none font-semibold",
              tile.emphasis === "attention" && "text-amber-600 dark:text-amber-400",
            )}
          >
            {tile.count}
          </span>
        )}
      </button>
    </li>
  );
}
