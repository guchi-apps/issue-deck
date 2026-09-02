"use client";

import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Archive,
  BadgeCheck,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleSlash,
  Clock,
  Compass,
  ExternalLink,
  ListChecks,
  Loader2,
  Lock,
  MessageCircleQuestion,
  MessageSquare,
  ScanSearch,
  ScrollText,
  Star,
} from "lucide-react";

import { IssueAgentBadge } from "@/components/dashboard/issue-agent-badge";
import { ManualStepRunBadge } from "@/components/dashboard/manual-step-run-badge";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { SnoozeMenu } from "@/components/dashboard/snooze-menu";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import {
  QueueStepBadge,
  WorkflowStepBadge,
} from "@/components/dashboard/workflow-status-steps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueListScroll } from "@/hooks/use-issue-list-scroll";
import { useIssuesWorkflowRunning } from "@/hooks/use-issues-workflow-running";
import { useNow } from "@/hooks/use-now";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { describeAutoRefreshState, type AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { formatCheckUserListCount } from "@/lib/check-user-attention";
import {
  resolveIssueExecutionTarget,
  type IssueExecutionTarget,
} from "@/lib/dispatch/issue-execution-target";
import {
  findSessionForIssue,
  resolveIssueImplementationAgent,
  summarizeIssueSession,
} from "@/lib/dispatch/issue-session";
import {
  buildIssueQueueStates,
  findIssueQueueState,
  type IssueQueueState,
} from "@/lib/dispatch/issue-queue-state";
import {
  describeDispatchJobWaitReason,
  summarizeDispatchQueue,
} from "@/lib/dispatch/queue-summary";
import { findPlanRequestForIssue } from "@/lib/dispatch/session-plan-request";
import { findQuestionRequestForIssue } from "@/lib/dispatch/session-question-request";
import { shouldEmphasizeRemoteControl } from "@/lib/remote-control-attention";
import {
  isActiveManualStepRun,
  sortManualStepRunsForList,
} from "@/lib/manual-step-run-view";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatDateTime, formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isApprovalPending } from "@/lib/github/approval-labels";
import { isStartImplementationOptionLabel } from "@/lib/github/start-implementation";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
import { groupIssuesByRepository, type IssueRepositoryGroup } from "@/lib/issue-stats";
import { isProgressLabel } from "@/lib/issue-status";
import {
  formatManualStepListCount,
  type ManualStepReadiness,
  type ManualStepReadinessMap,
} from "@/lib/manual-step-attention";
import { getLabelBadgeStyle } from "@/lib/label-color";
import {
  formatQuestionListCount,
  isQaAnswerWaiting,
  resolveQuestionState,
  type QuestionState,
} from "@/lib/question-attention";
import {
  describeSnoozeResume,
  describeSnoozeUntil,
  findActiveIssueSnooze,
  isSnoozeEnabledForList,
  type SnoozeEntry,
  type SnoozeMap,
  type SnoozeTarget,
} from "@/lib/snooze";
import { cn } from "@/lib/utils";
import type { Issue, IssueLabel, NavViewId } from "@/types/issue";

type IssueListProps = {
  title: string;
  issues: Issue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: Issue) => void;
  className?: string;
  style?: CSSProperties;
  showSearch?: boolean;
  showHeader?: boolean;
  /** 画面右下に浮くFAB（新規Issue作成ボタン）と最後の項目が重ならないよう下部に余白を確保する */
  fabSpacing?: boolean;
  /** スマホのボトムナビ（フッター）と最後の項目が重ならないよう、フッターと同じ高さの空白を末尾に追加する（#677） */
  footerSpacing?: boolean;
  /**
   * スクロール位置を保存・復元する単位を表すキー（#773）。画面種別と絞り込み条件から作り、
   * 条件が変われば別の一覧として扱う。省略時は保存・復元を行わない。
   */
  scrollKey?: string | null;
  /**
   * リポジトリごとのグループヘッダーを挟んで表示するか（#849）。絞り込み結果に
   * リポジトリが1種類しかない場合はヘッダーを出さずフラット表示のまま扱う。
   */
  groupByRepo?: boolean;
  /**
   * 現在表示中のナビビュー。グループ化時の並び順の切り替え（#922）にのみ使う。
   * 「直近本番に反映した」ビューでは、最後に反映したリポジトリが上に来るよう
   * グループの並び順をrepositoryFullName昇順ではなくclosedAt降順にする。
   */
  view?: NavViewId;
  /**
   * 一覧の先頭（ヘッダーの下・スクロール領域の外）へ差し込む枠（#1613）。
   * 「ユーザーの確認待ち」でマージ待ちPRを並べるために使う。Issueが0件でも描く——
   * 確認すべきものが残っているのに「該当するIssueがありません」だけになると逆に読み違える。
   */
  pinnedSection?: ReactNode;
  /**
   * `pinnedSection`に並ぶ件数（#1713）。ヘッダーの「N件」へ合流させる。左メニューの
   * 「ユーザーの確認待ち」はIssueとマージ待ちPRを足した数を出しているため、ここで足さないと
   * メニューの件数と一覧の件数だけが食い違う。
   */
  pinnedCount?: number;
  /**
   * 保留中で`pinnedSection`から外したもの（#2398）。マージ待ちPull Requestを伏せたぶんで、
   * 「保留中N件」の1行を開いたときに保留中のIssueと一緒に並べる。
   *
   * **PR側に別の1行を作らない**ため、件数・期限・枠をここで受け取って合流させる。
   */
  snoozedPinned?: {
    /** 件数。ヘッダーの内訳と1行の件数へ合流させる */
    count: number;
    /** いつ戻るかを1行にまとめるための保留（`describeSnoozeResume`へ渡す） */
    entries: SnoozeEntry[];
    /** 開いたときに並べる枠 */
    section: ReactNode;
  };
  /**
   * 手作業Issue（`71.manual-step`）が、いま実行できるかどうか（#1763）。
   * 行の右上へアイコンで出し、「ユーザーの作業待ち」ではヘッダーの件数にも使う。
   *
   * **絞り込み前の全Issueを母集団に作ったものを渡す。** 一覧が自分の`issues`だけで判定すると、
   * 手作業Issueしか並ばないこのビューでは参照先の通常Issueが手元に無く、全件が
   * 「状態不明＝実行できる」になる。省略した場合はアイコンを出さない。
   */
  prerequisiteReadiness?: ManualStepReadinessMap;
  /**
   * ユーザーが「いまは実施しない」として伏せた項目の引き当て表（#2398。`lib/snooze.ts`）。
   *
   * **効かせるのは要対応の2ビュー（`check-user`・`manual-step`）だけ。** 他の一覧では
   * 保留中の行も今までどおり並び、時計ボタンも出さない。省略時は保留の仕組みごと出さない。
   */
  snoozes?: SnoozeMap;
  /** 保留にする・期限を付け替える（`useSnoozes`の`snooze`）。省略時は時計ボタンを出さない */
  onSnooze?: (target: SnoozeTarget, until: string | null) => void;
  /** 保留を解除する（`useSnoozes`の`unsnooze`）。省略時は解除ボタンを出さない */
  onUnsnooze?: (target: SnoozeTarget) => void;
  /**
   * 確認待ち（`00.check-user`）のうち、まだエージェントが動いていて押せる操作が無いIssueのid
   * （#2174。判定は`lib/check-user-attention.ts`）。
   *
   * 左メニューの件数はこれを外した数を出すため、ヘッダーが行数のままだと数字だけが食い違う。
   * **一覧には今までどおり並べ**、ヘッダーの内訳（`2件・実行中1件`）で説明する。
   * 省略時は今までどおり行数を出す。
   *
   * **各行の進捗バッジ（`WorkflowStepBadge`）の回転にも同じ集合を使う**（#2358）。
   * 「確認待ちだがまだ動いている」を件数では実行中として扱いながら、バッジだけ止めていると、
   * 同じ画面の2か所が同じIssueについて逆のことを言うことになる。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
  /**
   * 手作業アシスタント（#1826）を開く。「ユーザーの作業待ち」でだけ使う。
   * 渡さない・実行できる手作業が1件も無い場合はボタンを出さない。
   *
   * `startIssueId`を渡すとそのIssueが案内の先頭になる（自動実行バッジの一覧から
   * 開くときに使う。#2119）。省略すると今までどおり`buildManualStepQueue`の並び順
   */
  onStartManualStepGuide?: (startIssueId?: string) => void;
  /**
   * 「次にやること」（#1853）を開く。「未着手」でだけ使う。
   * 渡さない・未着手が1件も無い場合はボタンを出さない。
   * `CLAUDE_CODE_OAUTH_TOKEN`が未設定の環境では親（`useIssueOrderGuide`の`notConfigured`）が
   * 渡すのをやめるので、押しても何も起きないボタンが残らない
   */
  onStartIssueOrder?: () => void;
  /**
   * コードレビュー（#698）を実行するダイアログを開く。「コードレビュー」ビューでだけ使う。
   *
   * **ヘッダーではなく一覧の上に置く**（手作業アシスタント・「次にやること」と同じ理由）。
   * このビューには他に起動の入口が無いので、**Issueが0件でも出す**——出さないと、最初の
   * 1件を作る手段が画面から無くなる。
   */
  onStartCodeReview?: () => void;
  /** 「次にやること」で1位を自動でサブPCへ積む設定か（#1853）。ボタンの文言が変わる */
  issueOrderAutoStart?: boolean;
  /**
   * 「次にやること」が判定の対象にする件数（#1853）。**この一覧の行数ではなく、
   * ユーザーの絞り込みを通していない「未着手」の総数**を渡す（`useIssueOrderGuide`）。
   * 一覧の行数を出すと、リポジトリで絞ったときに「N件あります」と実際に判定する件数がずれる
   */
  issueOrderCount?: number;
  /**
   * 絞り込みを指定しているのに、このビューでは適用されない状態か（#1750）。
   * 判定は`hasIgnoredIssueFilters`で行い、ここは受け取った結果を注記として出すだけ。
   * 黙って無視すると、キーワードやリポジトリを選んでも件数が変わらない理由が画面から読めない。
   */
  filtersIgnored?: boolean;
  /**
   * ディスパッチの状態（#1638）。**同じ画面で既に取っているなら渡す**（#1262の取り決め）。
   * スマホのIssue一覧はヘッダーの実行状況ボタンと一覧が同じものを見るため、画面側で1回
   * 取って両方へ配っている。省略時はこの一覧が自分で取りに行く（PCの一覧は従来どおり）。
   */
  dispatch?: DispatchStateHandle;
  /**
   * 一覧を下へ引っ張ったときに実行する更新（#1893）。**渡した画面でだけ有効になる。**
   * 引っ張るという操作はタッチにしか無く、PCの一覧は渡さないので今までどおり。
   */
  onPullToRefresh?: () => Promise<unknown> | void;
  /**
   * 最終取得時刻（ISO8601）。未取得・渡さない場合は出さない（#1797）。
   * PR一覧・ブランチ画面と同じ「◯件 ・ HH:MM時点」の形でヘッダーに出す。
   */
  fetchedAt?: string | null;
  /**
   * 自動更新の間隔（#1797）。`null`＝自動更新しない。**渡した一覧だけがヘッダーに状態を出す**
   * ——取り直しを持たない一覧（Issue詳細から開く小さな一覧など）に「手動更新のみ」と
   * 出しても、押す手段が無いことしか伝わらない。
   */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
};

// 要対応ラベル（00.check-userと、その理由を表す01.check-*）と、廃止済みの進捗ラベル
// （01〜09番台。#991 Phase 5・#1010）が他リポジトリに残っていた場合は、カード右上の
// WorkflowStepBadgeが進捗と確認待ちの理由を表現するため、下部のラベル一覧からは除外する。
// **実装オプションのラベルも出さない**（#1915）。「実装を開始」ダイアログで選んだ走らせ方で、
// 盤面を眺めるときの手掛かりにならないうえ、ラベル行が2行に折り返してRemote Controlを
// 置く場所が無かった。付いているものをすべて見るのはIssue詳細の役割
function listCardLabels(labels: IssueLabel[]) {
  return labels.filter(
    (label) => !isProgressLabel(label.name) && !isStartImplementationOptionLabel(label.name),
  );
}

function IssueStateIcon({ issue }: { issue: Issue }) {
  if (issue.state === "open") {
    return <CircleDot className="size-3 shrink-0 text-green-600" aria-label="Open" />;
  }
  if (issue.stateReason === "not_planned") {
    return (
      <CircleSlash
        className="size-3 shrink-0 text-muted-foreground"
        aria-label={closedStateLabel(issue.stateReason)}
      />
    );
  }
  return (
    <CircleCheck
      className="size-3 shrink-0 text-purple-600"
      aria-label={closedStateLabel(issue.stateReason)}
    />
  );
}

/**
 * 前提条件がそろっているか（#1763。#2003で手作業Issue以外にも出すようにした）。
 * Issue詳細の「前提条件の状況」（#1705）と同じ判定・同じ配色（emerald／amber）で、
 * 一覧のまま「どれをいま進められるか」が分かるようにする。
 *
 * **前提を書いていないIssueには何も出ない**（`computeIssuePrerequisiteReadiness`が載せない）。
 * 全行にアイコンが並ぶと、前提待ちの橙が埋もれる。
 *
 * 説明は`title`（PCのホバー）と`aria-label`に持たせる。スマホはホバーできないため、
 * 内訳はヘッダーの件数（`formatManualStepListCount`）とIssue詳細が担う。
 */
/**
 * 完了の確認コマンドが定期巡回で通った印（#2008）。
 *
 * **前提条件の印（`ManualStepReadinessIcon`）とは別に出す。** あちらは「いま実行してよいか」、
 * こちらは「もう実行し終えているかもしれない」で、答えている問いが違う。手作業Issueの色である
 * violet（`71.manual-step`ラベルと同じ）を使い、前提の緑・橙と読み違えないようにする。
 */
function ManualStepVerifiedIcon({ verifiedAt }: { verifiedAt: string | null }) {
  if (!verifiedAt) return null;
  const label = `完了済みの可能性（${formatDateTime(verifiedAt)}の巡回で確認コマンドがすべて成功）`;
  return (
    <span title={label} className="flex shrink-0 items-center">
      <BadgeCheck
        className="size-3.5 text-violet-600 dark:text-violet-400"
        aria-label={label}
      />
    </span>
  );
}

function ManualStepReadinessIcon({ readiness }: { readiness: ManualStepReadiness | undefined }) {
  if (!readiness) return null;
  const Icon = readiness.ready ? CircleCheckBig : Clock;
  return (
    <span title={readiness.message} className="flex shrink-0 items-center">
      <Icon
        className={cn(
          "size-3.5",
          readiness.ready
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-600 dark:text-amber-400",
        )}
        aria-label={readiness.ready ? "前提条件がそろっている" : "前提条件の完了待ち"}
      />
    </span>
  );
}

/**
 * 質問Issueの状態ラベル（#1796）。**「質問」ビューに限らず、質問Issueが並ぶ行すべてに出す。**
 * 状態はIssue自体の性質で、どのビューから見ても同じものだから。
 *
 * 読み終わったもの（`confirmed`）と質問以外（null）には何も出さない——一覧の大半を占める
 * 通常のIssueにまでラベルが増えると、隣に並ぶGitHubのラベルが読めなくなる。
 *
 * **回答待ちだけは質問Issue以外にも出し、アイコンを回す**（#2309）。判定を`waiting`
 * （`isQaAnswerWaiting`）で受け取るのは、「質問する」ボタンが通常のIssueのコメント欄にも
 * あるため（`resolveQuestionState`の`waiting`はタイトルが質問Issueの形のものしか通さない）。
 * 回すのは待っているのが処理だから——**承認待ち（琥珀）は人を待っているので回さない**
 * （`WorkflowStepBadge`の掃く光と同じ使い分け）。未確認も回さない。
 */
function QuestionStateBadge({
  state,
  waiting,
}: {
  state: QuestionState | null;
  /** 回答待ちか（`isQaAnswerWaiting`の結果。質問Issueに限らない） */
  waiting: boolean;
}) {
  if (!waiting && state !== "unconfirmed") return null;
  return (
    <span
      title={
        waiting
          ? "質問を投げたところで、まだ回答が届いていません"
          : "回答が届いていますが、まだ開いていません"
      }
      className={cn(
        "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
        waiting
          ? "bg-blue-500/15 text-blue-700 ring-blue-500 dark:text-blue-400"
          : "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400",
      )}
    >
      {waiting && <Loader2 className="size-3 animate-spin" />}
      {waiting ? "回答待ち" : "未確認"}
    </span>
  );
}

// グループ表示中は各行のリポジトリ名表示がヘッダーと重複するため省略する（#849）
function GroupHeader({ group }: { group: IssueRepositoryGroup }) {
  return (
    <div className="flex items-center gap-1.5 border-b bg-muted/50 px-4 py-2 text-xs font-semibold text-muted-foreground">
      <span className="truncate">{group.repositoryFullName.split("/")[1]}</span>
      {group.repositoryArchived && <Archive className="size-3 shrink-0" aria-label="アーカイブ済み" />}
      {group.repositoryPrivate && <Lock className="size-3 shrink-0" aria-label="プライベート" />}
      <span className="ml-auto shrink-0">{group.issues.length}件</span>
    </div>
  );
}

/**
 * 一覧の上に並ぶ「〜が n件あります。」の入口バー（手作業アシスタント・「次にやること」）で
 * 共有する見た目。
 *
 * **入りきらないときは折り返す**（#2107）。以前は1行固定の`flex`で、右のバッジ・ボタンだけに
 * `shrink-0`が付いていた。中央カラムは手で狭められる（#381）ため、縮められるものが左の
 * `flex-1`のテキストしか無くなり、幅0まで潰れて1文字ずつ縦に並ぶ。右が「自動実行 n / m」
 * バッジとボタンの2つになる手作業のバーで最初に起きる。
 *
 * - `flex-wrap`＋テキストの`basis-48`（12rem）で、テキストが読める幅を切ったらボタン側が
 *   次の行へ落ちる。**基準幅を与えるのが肝**で、`flex-1`（`basis-0%`）のままだと
 *   テキストは幅0まで縮むだけで折り返しの合図にならない
 * - 伸ばす指定は`flex-1`ではなく`grow`にする。`flex-1`は`flex`ショートハンドなので
 *   `basis-48`と同じ`flex-basis`を奪い合い、どちらが勝つかがTailwindのCSS出力順に依存する
 *   （いまの版は`basis-*`が後に出るので効くが、順が変われば黙って1文字ずつに戻る）。
 *   `grow`は`flex-grow`だけを触るので競合しない
 * - 落ちたボタン側は`ml-auto`で右端に残す。左端に来ると本文と縦に並び、押す場所が読みにくい
 * - 幅に余裕があるときの見た目は従来どおり（1行・テキスト左・ボタン右）
 */
const COUNT_BAR_CLASS = "flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2";
const COUNT_BAR_TEXT_CLASS = "min-w-0 grow basis-48 text-xs text-muted-foreground";
const COUNT_BAR_ACTIONS_CLASS = "ml-auto flex shrink-0 items-center gap-2";

export function IssueList({
  title,
  issues: allIssues,
  selectedIssueId,
  onSelectIssue,
  className,
  style,
  showSearch = true,
  showHeader = true,
  fabSpacing = false,
  footerSpacing = false,
  scrollKey = null,
  groupByRepo = false,
  view,
  pinnedSection,
  pinnedCount = 0,
  snoozedPinned,
  prerequisiteReadiness,
  snoozes,
  onSnooze,
  onUnsnooze,
  checkUserRunningIssueIds,
  onStartManualStepGuide,
  onStartIssueOrder,
  onStartCodeReview,
  issueOrderAutoStart = false,
  issueOrderCount = 0,
  filtersIgnored = false,
  dispatch: injectedDispatch,
  onPullToRefresh,
  fetchedAt = null,
  autoRefreshIntervalMs,
}: IssueListProps) {
  // 現在時刻(epoch ms)。保留の期限判定と相対時刻の表示が同じ値を見る（#2398・#1891）
  const now = useNow();
  /**
   * 「いまは実施しない」として伏せた行を一覧から外す（#2398・#2456）。
   *
   * **効かせるのはIssue一覧のすべてのビュー**（#2456）。#2398では要対応の2ビュー
   * （`check-user`・`manual-step`）だけに限っていたが、「すべてのIssue」に並んだままだと
   * 保留にしても日常的に見る一覧からは減らず、伏せた意味が半分しか無かった。
   * **伏せたものがどこにも出てこなくなる**という#2398の懸念は、どのビューでも
   * 一覧の上の1行から「表示」で開けることで担保する。
   *
   * **左メニューの件数（`computeNavCountsForFilters`）と同じ判定**なので、メニューの
   * 数字と並んでいる行数は食い違わない。伏せたぶんはヘッダーの内訳（`2件・保留中1件`）と、
   * 一覧の上に出す「保留中がN件あります」の1行で読める。
   *
   * 判定そのものは`lib/snooze.ts`（`isSnoozeEnabledForList`）が持つ——同じ条件が
   * スマホの一覧（`mobile-issue-list-screen.tsx`）にもあり、片方だけ直すと
   * ヘッダーの数字と並ぶ行数が食い違う。
   */
  const snoozeEnabled = isSnoozeEnabledForList(snoozes, onSnooze);
  const { issues, snoozedIssues } = useMemo(() => {
    if (!snoozeEnabled || !snoozes) return { issues: allIssues, snoozedIssues: [] as Issue[] };
    const listed: Issue[] = [];
    const snoozed: Issue[] = [];
    for (const issue of allIssues) {
      (findActiveIssueSnooze(snoozes, issue, now) ? snoozed : listed).push(issue);
    }
    return { issues: listed, snoozedIssues: snoozed };
  }, [allIssues, snoozes, snoozeEnabled, now]);
  // 保留中の行を開いているか。**既定はたたむ**——伏せたものを見に来るのは解除するときだけで、
  // 開いたままにすると件数から外した意味が薄れる
  const [isSnoozedOpen, setIsSnoozedOpen] = useState(false);
  // 伏せたIssueとマージ待ちPRを合わせた件数と期限。**1行にまとめて出す**ので、ここで合流させる
  const snoozedTotal = snoozedIssues.length + (snoozedPinned?.count ?? 0);
  const snoozedEntries = useMemo(() => {
    const fromIssues = snoozes
      ? snoozedIssues.flatMap((issue) => {
          const entry = findActiveIssueSnooze(snoozes, issue, now);
          return entry ? [entry] : [];
        })
      : [];
    return [...fromIssues, ...(snoozedPinned?.entries ?? [])];
  }, [snoozedIssues, snoozes, snoozedPinned, now]);

  // 実行先の解決（#1262）。`GET /api/dispatch`は一覧ぶんをまとめて返すので、Issueの件数に
  // 関わらず取得は1本で足りる。**Actionsの実行を期待できないIssueをポーリングから外す**ため、
  // ポーリングのフックより先に求める必要がある。
  const ownDispatch = useDispatchState(injectedDispatch === undefined);
  const dispatch = injectedDispatch ?? ownDispatch;
  const executionTargetByIssueId = useMemo(() => {
    const map = new Map<string, IssueExecutionTarget>();
    for (const issue of issues) {
      map.set(
        issue.id,
        resolveIssueExecutionTarget({
          repositoryFullName: issue.repositoryFullName,
          issueNumber: issue.number,
          labels: issue.labels,
          jobs: dispatch.jobs,
          sessions: dispatch.sessions,
        }),
      );
    }
    return map;
  }, [issues, dispatch.jobs, dispatch.sessions]);
  // セッション（#1264）。添える文言（入力待ち・終了・異常終了）と、バッジの外周を回すかどうか
  // （#1439）の両方をバッジ側がここから決める
  const sessionByIssueId = useMemo(() => {
    const map = new Map<string, DispatchSessionView>();
    for (const issue of issues) {
      const session = findSessionForIssue(
        dispatch.sessions,
        issue.repositoryFullName,
        issue.number,
      );
      if (session) map.set(issue.id, session);
    }
    return map;
  }, [issues, dispatch.sessions]);
  // 実行が始まる前の状態（#2449）。積んだ直後のIssueは進捗Statusが`Ready`のままで右上の
  // 進捗バーが描かれず、行が押す前とまったく同じに見えていた。**Issueの件数に関わらず
  // 組み立ては1回**で、行ごとにジョブ一覧を走査し直さない
  const queueStateByIssueId = useMemo(() => {
    // 並べ替えは実行キューの要約に任せる（#2449）。同じ規則をここで書き直すと、
    // ポップオーバーの並びと一覧の番号が同じ画面で食い違いうる
    const states = buildIssueQueueStates(
      summarizeDispatchQueue(dispatch.jobs, dispatch.concurrency),
    );
    const map = new Map<string, IssueQueueState>();
    if (states.size === 0) return map;
    for (const issue of issues) {
      const state = findIssueQueueState(states, issue.repositoryFullName, issue.number);
      if (state) map.set(issue.id, state);
    }
    return map;
  }, [issues, dispatch.jobs, dispatch.concurrency]);
  // 計画への返事待ち（#2061）。**待っている行だけ「計画を承認」を出す**ための集合で、
  // 押した先はアプリの中（そのIssueを開くと上部に計画パネルが出る）
  const planPendingIssueIds = useMemo(() => {
    const ids = new Set<string>();
    // **テストの差し込みや古い応答では欠けうる**ので、無ければ「待っているものは無い」として読む
    const requests = dispatch.planRequests ?? [];
    if (requests.length === 0) return ids;
    for (const issue of issues) {
      const request = findPlanRequestForIssue(
        requests,
        issue.repositoryFullName,
        issue.number,
      );
      if (request?.status === "WAITING") ids.add(issue.id);
    }
    return ids;
  }, [issues, dispatch.planRequests]);
  // 質問への回答待ち（#2189）。計画の返事待ちと同じで、**待っている行だけ「質問に答える」を
  // 出す**（押した先はアプリの中で、そのIssueを開くと上部に回答パネルが出る）
  const questionPendingIssueIds = useMemo(() => {
    const ids = new Set<string>();
    const requests = dispatch.questionRequests ?? [];
    if (requests.length === 0) return ids;
    for (const issue of issues) {
      const request = findQuestionRequestForIssue(
        requests,
        issue.repositoryFullName,
        issue.number,
      );
      if (request?.status === "WAITING") ids.add(issue.id);
    }
    return ids;
  }, [issues, dispatch.questionRequests]);
  const actionsUnexpectedIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, target] of executionTargetByIssueId) {
      if (!target.expectsActionsRun) ids.add(id);
    }
    return ids;
  }, [executionTargetByIssueId]);
  const runningByIssueId = useIssuesWorkflowRunning(issues, actionsUnexpectedIssueIds);
  // 押した行を即座にハイライトするための楽観表示（#1597）。選択の正はURLクエリ
  // （`?issue=`）で、その更新はReactのトランジション＝低優先度の更新として入るため、
  // 右カラム（IssueDetail・プロパティパネル）の再描画が終わるまでハイライトが動かない。
  // ここは行のクリックで直接（緊急の更新として）持ち、正の選択が追いついたら捨てる。
  const [optimisticSelectedId, setOptimisticSelectedId] = useState<string | null>(null);
  // 正の選択が変わったら楽観表示は用済み。別経路（確認待ちトースト・本文中のIssueリンク）で
  // 選択が変わった場合も、こちらが古い行を指し続けないようここで揃える。effectで同期すると
  // 描画が1回余分に走るため、レンダー中に比較して更新する（topbar.tsxの検索欄と同じ形）。
  const [syncedSelectedIssueId, setSyncedSelectedIssueId] = useState(selectedIssueId);
  if (selectedIssueId !== syncedSelectedIssueId) {
    setSyncedSelectedIssueId(selectedIssueId);
    setOptimisticSelectedId(null);
  }
  const highlightedIssueId = optimisticSelectedId ?? selectedIssueId;

  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);
  // 引っ張って更新（#1893）。タッチを受けるのは一覧を包む枠で、スクロール位置は<ul>から見る
  // （0件のときは<ul>ごと消えるため、<ul>に直接付けると空の一覧で引っ張れなくなる）
  const pullContainerRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({
    containerRef: pullContainerRef,
    scrollRef: listRef,
    onRefresh: onPullToRefresh,
  });
  const issueIds = useMemo(() => issues.map((issue) => issue.id), [issues]);

  // 一覧が再マウントされた直後（Issue詳細から戻ってきた等）に、直前まで見ていた位置へ戻す。
  // scrollIntoView()は祖先のoverflow-hiddenコンテナ（ヘッダー等を含む）まで巻き込んで
  // スクロールさせてしまうため使わず、<ul>自身のscrollTopのみを直接操作する。
  useIssueListScroll({ scrollKey, issueIds, selectedIssueId, listRef, itemRefs });

  // リポジトリが1種類しかない場合（絞り込みで単一リポジトリのときなど）はヘッダーを
  // 出す意味がないため、フラット表示のまま扱う。
  const repoGroups = useMemo(
    () =>
      groupByRepo
        ? groupIssuesByRepository(issues, { sortByLatestClosedAt: view === "recently-merged" })
        : null,
    [groupByRepo, issues, view],
  );
  const isGrouped = Boolean(repoGroups && repoGroups.length > 1);

  // 「ユーザーの作業待ち」だけは、左メニューと同じ「いま実行できる件数」を先に出し、
  // 差である前提待ちを添える（#1763）。「質問」は総数に未確認の内訳を添える（#1796。
  // 左メニューの数字は総数のままで、色でしか未確認の有無が出ないため）。
  // 「ユーザーの確認待ち」も同じ形で、実行中のぶんを差として添える（#2174）。
  // 他のビューは今までどおり並んでいる行数。
  const listedCount = issues.length + pinnedCount;
  const checkUserRunningCount =
    view === "check-user" && checkUserRunningIssueIds
      ? issues.filter((issue) => checkUserRunningIssueIds.has(issue.id)).length
      : 0;
  const countLabel =
    (view === "manual-step" && prerequisiteReadiness
      ? formatManualStepListCount(issues, prerequisiteReadiness, snoozedTotal)
      : null) ??
    (view === "question" ? formatQuestionListCount(issues, listedCount, snoozedTotal) : null) ??
    formatCheckUserListCount(listedCount, checkUserRunningCount, snoozedTotal) ??
    `${listedCount}件`;

  // アシスタントが案内できるのは「いま実行できる」手作業だけ（`buildManualStepQueue`）。
  // 1件も無いときにボタンを出すと、押しても何も案内されない画面が開く
  const guidableManualStepCount =
    view === "manual-step" && prerequisiteReadiness
      ? issues.filter((issue) => prerequisiteReadiness.get(issue.id)?.ready === true).length
      : 0;

  // 走っている自動実行（#1882）。**入口に出すのはこの一覧に居る手作業の分だけ**——
  // 別のビューを見ているときに手作業の進捗を割り込ませない。
  // **#2073で実行キューの節を撤去したので、進み具合が出る常設の場所はここだけ**
  // （ここはバッジで、中断できるのはアシスタントの中）
  // **拾うのは走っている全件**（#2119）。`.find`で先頭1件しか見ていなかったため、
  // 複数走っていても1件ぶんの進捗しか出ず、2本目以降は画面のどこにも出ていなかった
  const activeManualStepRuns =
    view === "manual-step"
      ? sortManualStepRunsForList(
          (dispatch.manualStepRuns ?? []).filter(
            (run) =>
              isActiveManualStepRun(run.status) &&
              issues.some(
                (issue) =>
                  issue.repositoryFullName === run.repositoryFullName &&
                  issue.number === run.issueNumber,
              ),
          ),
        )
      : [];

  /**
   * 保留中の行（#2398）。**通常の行より情報を削る**——ここに来るのは解除するときだけで、
   * 進捗バッジや実行の導線を並べると「伏せた」ようには見えない。
   */
  function renderSnoozedRow(issue: Issue) {
    const entry = snoozes ? findActiveIssueSnooze(snoozes, issue, now) : null;
    return (
      <li key={issue.id} className="border-b last:border-b-0">
        <div className="flex flex-col gap-1.5 px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onSelectIssue(issue)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate text-xs text-muted-foreground">
                {issue.repositoryFullName.split("/")[1]}
              </span>
              <span className="line-clamp-2 text-sm text-muted-foreground">
                #{issue.number} {issue.title}
              </span>
            </button>
            <span className="flex shrink-0 items-center gap-1.5">
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Clock className="size-3" />
                {describeSnoozeUntil(entry?.until ?? null, now)}
              </Badge>
              {onUnsnooze && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    onUnsnooze({
                      kind: "issue",
                      repositoryFullName: issue.repositoryFullName,
                      number: issue.number,
                    })
                  }
                >
                  解除
                </Button>
              )}
            </span>
          </div>
        </div>
      </li>
    );
  }

  function renderIssueRow(issue: Issue, showRepoName: boolean) {
    const issueSession = sessionByIssueId.get(issue.id) ?? null;
    // 実行中は一覧から保留にして処理を隠せないようにする（#2610）。GitHub Actionsと
    // ローカルエージェントの判定は、それぞれ既存の一覧用の状態をそのまま使う。
    const isRunning =
      Boolean(runningByIssueId[issue.id]?.isRunning) ||
      (checkUserRunningIssueIds?.has(issue.id) ?? false);
    // 一覧から直接開く出口（#1915）。**出す条件はIssue詳細（`IssueSessionStatus`）と同じ**で、
    // 判定は`summarizeIssueSession`に任せる。終了したセッション・まだ開始していないセッションの
    // URLは開いても意味が無く、そこで同じ分岐をここに書き足すと片方だけ古くなる
    const remoteControlUrl = (() => {
      return issueSession ? summarizeIssueSession(issueSession).remoteControlUrl : null;
    })();
    // 押さないと先へ進まない行を見分けられるようにする（#1964）。**出す条件とは別物**で、
    // 判定は`shouldEmphasizeRemoteControl`に置いてある
    // 計画への返事を画面から送れる行（#2061）。**ここが主導線になり、Remote Controlは
    // 通常の枠線へ戻る**（`shouldEmphasizeRemoteControl`が`false`を返す）
    const planPending = planPendingIssueIds.has(issue.id);
    // 質問への回答待ち（#2189）。計画の承認と同じ扱いで、こちらも主導線になる
    const questionPending = questionPendingIssueIds.has(issue.id);
    /**
     * 右上の進捗バッジ（`WorkflowStepBadge`）が回答待ちを言うか（#2309）。**言うなら
     * `QuestionStateBadge`の「回答待ち」は出さない**——同じ行の左右で同じことを2回言わせない
     * （`docs/code-map.md`「同じ状態を2か所で言わせない。誰が言うかは並べる側が決める」）。
     * 判定を行の側に置いているのは、どちらを出すかを知れるのが両方を並べているここだけだから。
     *
     * バッジはProject Statusを持たない行では何も描かず（`getWorkflowStepIndex`がnull）、
     * 承認待ちの行では確認待ちの方を優先する（`workflow-status-steps.tsx`の
     * `showQaAnswerPending`と同じ条件）。そのどちらでも回答待ちはこの行から読めなくなるので、
     * ラベル側が引き受ける。質問Issueは`ready`のまま置かれるのが普通なので、実際に出るのは
     * ほぼこちら。
     */
    const stepBadgeShowsQaAnswerPending =
      getWorkflowStepIndex({ projectStatus: issue.projectStatus }) !== null &&
      !isApprovalPending(issue.labels);
    /**
     * 実行が始まる前の状態（#2449）。**バーを2つ並べない**ので、進捗バーが描かれる行では
     * `WorkflowStepBadge`へ渡して添える字にし、描かれない行（＝積んだ直後のStatusが`Ready`の
     * まま）だけ`QueueStepBadge`を出す。どちらを出すかを知れるのは両方を並べているここだけ
     * （`docs/code-map.md`「同じ状態を2か所で言わせない。誰が言うかは並べる側が決める」）。
     */
    const queueState = queueStateByIssueId.get(issue.id) ?? null;
    const stepBadgeVisible = getWorkflowStepIndex({ projectStatus: issue.projectStatus }) !== null;
    // 上限・メモリ逼迫で待ちが進まない理由（#1394）。判定は実行キュー・Issue詳細と同じ関数で、
    // ここに条件を書き足さない
    const queueWaitReason = queueState
      ? describeDispatchJobWaitReason(queueState.job, dispatch.hosts)
      : null;
    const emphasizeRemoteControl = shouldEmphasizeRemoteControl({
      labels: issue.labels,
      session: sessionByIssueId.get(issue.id) ?? null,
      planDecisionPending: planPending || questionPending,
    });
    return (
      <li
        key={issue.id}
        ref={(el) => {
          if (el) itemRefs.current.set(issue.id, el);
          else itemRefs.current.delete(issue.id);
        }}
        className={cn(
          // isolateで行の中に重なり順を閉じ込める（#1945）。下のz-0/z-10は当たり判定と本文の
          // 前後だけを決めたいもので、これが無いと一覧の外にある要素（右下の丸ボタンなど）と
          // 同じ土俵で比較され、z-indexを持たない側が一覧の後ろへ回ってしまう
          "relative isolate border-b border-l-4 border-l-transparent hover:bg-accent",
          highlightedIssueId === issue.id && "border-l-primary bg-accent",
        )}
      >
        {/* 行を選ぶ当たり判定（#1915）。**本文を包む`<button>`にしない。** ラベル行へ足した
            Remote Controlはリンク（`<a>`）で、ボタンの中に置くと不正なHTMLになり、押したときに
            Issueの選択まで走る。カード全面へ敷いたこのボタンを本文の下に置き、本文側は
            ポインタを透過させることで、見た目を変えずに「カードのどこを押しても選択」を保つ */}
        <button
          type="button"
          aria-label={`#${issue.number} ${issue.title}`}
          onClick={() => {
            setOptimisticSelectedId(issue.id);
            onSelectIssue(issue);
          }}
          className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        />
        <div className="pointer-events-none relative z-10 flex w-full flex-col gap-1.5 px-4 py-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <IssueStateIcon issue={issue} />
              {showRepoName && (
                <>
                  <span className="truncate">{issue.repositoryFullName.split("/")[1]}</span>
                  {issue.repositoryArchived && (
                    <Archive className="size-3 shrink-0" aria-label="アーカイブ済み" />
                  )}
                  {issue.repositoryPrivate && (
                    <Lock className="size-3 shrink-0" aria-label="プライベート" />
                  )}
                </>
              )}
            </span>
            {/* 進捗が円（18px）から横棒（40px）になり、右側のクラスタが22px広くなった（#2516）。
                `shrink-0`のままだと、一覧カラムを最小幅（280px）まで詰めたときに逃げ場が無く
                行からはみ出す。縮められるようにして、**添える字（「実装中（サブPC）」）だけが
                切り詰められる**ようにする（アイコン・バー・アバターは`shrink-0`のまま） */}
            <span className="flex min-w-0 items-center gap-1.5">
              <ManualStepVerifiedIcon verifiedAt={issue.manualStepVerifiedAt} />
              <ManualStepReadinessIcon readiness={prerequisiteReadiness?.get(issue.id)} />
              <WorkflowStepBadge
                labels={issue.labels}
                projectStatus={issue.projectStatus}
                running={runningByIssueId[issue.id]}
                qaAnswerPending={Boolean(issue.qaAnswerPendingAt)}
                executionTarget={executionTargetByIssueId.get(issue.id)}
                session={issueSession}
                now={now}
                // 確認待ちでもエージェントが動いている間は回し続ける（#2358）。判定は
                // 左メニュー・ヘッダーの件数と同じ集合（#2174）を使い、材料を増やさない
                checkUserRunning={checkUserRunningIssueIds?.has(issue.id) ?? false}
                queue={queueState}
                queueWaitReason={queueWaitReason}
              />
              {/* 進捗バーが描かれない行（積んだ直後のStatusが`Ready`のまま）だけ、
                  実行が始まる前の状態を同じ位置・同じ寸法のバーで出す（#2449） */}
              {!stepBadgeVisible && queueState && (
                <QueueStepBadge queue={queueState} waitReason={queueWaitReason} />
              )}
              {/* 「いまは実施しない」（#2398）。**どのビューの行にも出す**（#2456）——
                  伏せたい対象は要対応の一覧に居るとは限らず、目に入ったその場で下げられないと
                  「気になったら下げる」という使い方にならない。
                  行の当たり判定（カード全面の<button>）の上に重ねるので、
                  `pointer-events-auto`が要る（Remote Controlのリンクと同じ） */}
              {snoozeEnabled && onSnooze && !isRunning && (
                <SnoozeMenu
                  target={{
                    kind: "issue",
                    repositoryFullName: issue.repositoryFullName,
                    number: issue.number,
                  }}
                  onSnooze={onSnooze}
                  now={now}
                />
              )}
              {issue.favorite && (
                <Star
                  className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400"
                  aria-label="お気に入り"
                />
              )}
              <UserAvatar login={issue.assignee?.login ?? issue.author.login} />
            </span>
          </div>
          <p
            className={cn(
              "flex items-start gap-1.5 text-sm",
              issue.hasUnreadComments ? "font-semibold" : "font-medium",
            )}
          >
            {issue.hasUnreadComments && (
              <span
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blue-500"
                aria-label="未読コメントあり"
              />
            )}
            <span className="line-clamp-2 min-w-0 break-words">
              #{issue.number} {issue.title}
            </span>
          </p>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1">
              {issueSession && (
                <IssueAgentBadge agent={resolveIssueImplementationAgent(issueSession)} />
              )}
              <QuestionStateBadge
                state={resolveQuestionState(issue)}
                waiting={isQaAnswerWaiting(issue) && !stepBadgeShowsQaAnswerPending}
              />
              {listCardLabels(issue.labels).map((label) => (
                <span
                  key={label.name}
                  className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ring-1 ring-inset ring-border"
                  style={getLabelBadgeStyle(label.color)}
                >
                  {label.name}
                </span>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* 計画の承認へ入る（#2061）。**行き先はアプリの中**で、押すとそのIssueが開き、
                  上部に計画パネル（「計画の承認を待っています」）が出る。ここを出す間は
                  Remote Controlの強調を下ろすので、行の中でオレンジは1つに保たれる。
                  **`<a>`ではなく`<button>`**——外部へ出る導線ではないため */}
              {/* 質問への回答へ入る（#2189）。計画の承認と同じ作りで、**質問の方を先に出す**
                  ——計画を出したあとに質問することがあり、待たれているのは新しい方 */}
              {questionPending && (
                <Button
                  variant="outline"
                  size="xs"
                  className="pointer-events-auto border-amber-500 text-amber-700 hover:text-amber-700 dark:border-amber-500 dark:text-amber-400 dark:hover:text-amber-400"
                  title="質問に答える"
                  aria-label={`#${issue.number}の質問に答える`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOptimisticSelectedId(issue.id);
                    onSelectIssue(issue);
                  }}
                >
                  <MessageCircleQuestion />
                  質問に答える
                </Button>
              )}
              {planPending && !questionPending && (
                <Button
                  variant="outline"
                  size="xs"
                  className="pointer-events-auto border-amber-500 text-amber-700 hover:text-amber-700 dark:border-amber-500 dark:text-amber-400 dark:hover:text-amber-400"
                  title="計画を承認する"
                  aria-label={`#${issue.number}の計画を承認する`}
                  onClick={(event) => {
                    // 行そのものの当たり判定（カード全面のボタン）へ伝わらないようにする。
                    // 開く先は同じだが、二重に走らせない
                    event.stopPropagation();
                    setOptimisticSelectedId(issue.id);
                    onSelectIssue(issue);
                  }}
                >
                  <ScrollText />
                  計画を承認
                </Button>
              )}
              {/* 走っているセッションを一覧から開く（#1915）。**ラベル行の右端に置く**——
                  カードの下へ1行足すと、セッションのあるカードだけ高さが変わって一覧が
                  不揃いになる。文言は「Remote」まで詰め、全文は`title`・`aria-label`に持たせる */}
              {remoteControlUrl && (
                <Button
                  variant="outline"
                  size="xs"
                  asChild
                  className={cn(
                    "pointer-events-auto",
                    // 回答を待っている行だけ枠線と文字をamberにする（#1964）。**中は塗らない**——
                    // 同じ形の行が縦に続く画面で、塗りつぶしたボタンは1つあるだけで視線を奪う。
                    // 面（背景）とホバーの挙動はoutlineのまま変えず、差は枠線と文字色だけにする。
                    // 色は右上のバッジ（`WorkflowStepBadge`）の確認待ちと同じamberを借りる。同じ行で
                    // 同じ意味に別の色を当てない。**回転・点滅はさせない**（あちらも承認待ちでは
                    // 意図的に回転を止めている。待っているのは人であって処理ではない）
                    emphasizeRemoteControl &&
                      "border-amber-500 text-amber-700 hover:text-amber-700 dark:border-amber-500 dark:text-amber-400 dark:hover:text-amber-400",
                  )}
                >
                  <a
                    href={remoteControlUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="Claude Codeアプリで開く"
                    aria-label={`#${issue.number}のClaude Codeアプリで開く`}
                  >
                    <ExternalLink />
                    Remote
                  </a>
                </Button>
              )}
              {issue.commentCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <MessageSquare className="size-3" />
                  {issue.commentCount}
                </span>
              )}
              {/* 一覧はサーバーでも描かれるため、現在時刻は描画中に読まず`useNow`から受ける
                  （#1891）。分単位で刻むようになったぶん、サーバーで描いた時刻と
                  ハイドレーション時刻が分の境界をまたぐと表示が食い違う。マウント前
                  （`now === null`）は出しようがないので出さない */}
              <span>{now === null ? null : formatRelativeDate(issue.updatedAt, now)}</span>
            </div>
          </div>
        </div>
      </li>
    );
  }

  return (
    // min-h-0が無いと、この要素を`flex-1`で縦に並べたとき（スマホのIssue一覧）に
    // Issue件数ぶんの高さまで縮まなくなる（#1665）。flexアイテムの`min-height: auto`は
    // 「中身の最小サイズ」に解決され、内側の`<ul>`がoverflow-y-autoでも外側のこの要素は
    // overflowがvisibleなので0まで縮まない。結果、下に並ぶ兄弟（下端の絞り込み行）が
    // 親のoverflow-hiddenの外へ押し出され、件数が多いときだけ消えて見えた。
    // PullRequestListが同じ症状を出さないのは、ルートにoverflow-hiddenがあるため。
    <div className={cn("flex h-full min-h-0 flex-col", className)} style={style}>
      {showSearch && (
        <div className="border-b p-3">
          <Input placeholder="キーワードで検索" />
        </div>
      )}

      {showHeader && (
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {countLabel}
              {filtersIgnored && (
                <span title="このビューはリポジトリ横断で全体を表示します（#1750）。キーワード・リポジトリ・状態・ラベル・担当者の絞り込みは適用しません。">
                  {" ・ 絞り込みは適用外"}
                </span>
              )}
              {/* いつ時点の内容かと、自動更新の状態（#1797）。PR一覧・ブランチ画面と同じ並び・
                  同じ文言にそろえる。この一覧は開いている間ずっと10秒間隔で取り直しているが、
                  その形跡が画面に無く、止まっていても正常時と見分けが付かなかった */}
              {fetchedAt && <span>{` ・ ${formatTimeOfDay(fetchedAt)}時点`}</span>}
              {autoRefreshIntervalMs !== undefined && (
                <span>{` ・ ${describeAutoRefreshState(autoRefreshIntervalMs)}`}</span>
              )}
            </p>
          </div>
          <Star className="size-4 shrink-0 text-muted-foreground" />
        </div>
      )}

      {/* 溜まった手作業を1件ずつ案内する入口（#1826）。**ヘッダーではなく一覧の上に置く**——
          スマホの一覧はこのコンポーネントのヘッダーを出さず（`showHeader={false}`）、
          画面側のヘッダーには操作を足さない決まりのため（#1646）。ここならPC・スマホの
          どちらにも同じ位置で出る */}
      {onStartManualStepGuide &&
        (guidableManualStepCount > 0 || activeManualStepRuns.length > 0) && (
          <div className={cn(COUNT_BAR_CLASS, "bg-violet-500/5")}>
            <p className={COUNT_BAR_TEXT_CLASS}>
              いま実行できる手作業が
              <span className="font-medium text-foreground tabular-nums">
                {guidableManualStepCount}件
              </span>
              あります。
            </p>
            <div className={COUNT_BAR_ACTIONS_CLASS}>
              {/* 走っている自動実行があることを入口に出す（#1882）。**閉じても進んでいる**ので、
                  戻ってこられる目印がここに要る。押すと走っている実行が全部並び、行から
                  そのIssueのアシスタントを開ける（#2119） */}
              <ManualStepRunBadge
                runs={activeManualStepRuns}
                onOpenRun={(run) => {
                  // `run.issueId`は引けないことがあるので、並んでいるIssueから引き直す
                  const issue = issues.find(
                    (candidate) =>
                      candidate.repositoryFullName === run.repositoryFullName &&
                      candidate.number === run.issueNumber,
                  );
                  onStartManualStepGuide(issue?.id ?? run.issueId ?? undefined);
                }}
              />
              <Button size="xs" className="shrink-0" onClick={() => onStartManualStepGuide()}>
                <ListChecks />
                順番に進める
              </Button>
            </div>
          </div>
        )}

      {/* 未着手のIssueの着手順をClaudeに決めさせる入口（#1853）。手作業アシスタントと同じく
          ヘッダーではなく一覧の上に置くことで、PC・スマホのどちらにも同じ位置で出る。
          **自動開始が有効なら文言でそう伝える**——押した瞬間に実装セッションが積まれるので、
          「順番を決める」としか書いていないと、始まったことが押した本人から見えない */}
      {onStartIssueOrder && view === "not-started" && issueOrderCount > 0 && (
        <div className={cn(COUNT_BAR_CLASS, "bg-sky-500/5")}>
          <p className={COUNT_BAR_TEXT_CLASS}>
            未着手のIssueが
            <span className="font-medium tabular-nums text-foreground">{issueOrderCount}件</span>
            あります。
          </p>
          <div className={COUNT_BAR_ACTIONS_CLASS}>
            <Button size="xs" className="shrink-0" onClick={onStartIssueOrder}>
              <Compass />
              {issueOrderAutoStart ? "順番を決めて開始" : "順番を決める"}
            </Button>
          </div>
        </div>
      )}

      {/* リポジトリ全体のコードレビューを実行する入口（#698）。**このビュー唯一の起動口**なので、
          並んでいるIssueが0件でも出す */}
      {onStartCodeReview && view === "code-review" && (
        <div className={cn(COUNT_BAR_CLASS, "bg-emerald-500/5")}>
          <p className={COUNT_BAR_TEXT_CLASS}>
            リポジトリ全体を読ませて、指摘を受け取れます。
          </p>
          <div className={COUNT_BAR_ACTIONS_CLASS}>
            <Button size="xs" className="shrink-0" onClick={onStartCodeReview}>
              <ScanSearch />
              レビューを実行
            </Button>
          </div>
        </div>
      )}

      {/* 一覧のoverscroll-containは、端まで到達したあとの慣性スクロールが
          ドキュメント側へ伝播してヘッダー・フッターごと動くのを防ぐ（#607） */}
      {/* 引っ張って更新（#1893）のタッチを受ける枠。**0件のときも枠は残す**——<ul>は0件で
          消えるため、<ul>に直接付けると「該当するIssueがありません」の一覧を更新できない */}
      {/* **`pinnedSection`もこの枠の中に入れる**（#2175）。確認待ちの先頭に固定している
          マージ待ちPull Request（#1613）は画面の上半分を占めることがあり、枠の外に置くと
          そこを下へなぞってもタッチが届かず「引っ張っても何も起きない」ことになる */}
      <div ref={pullContainerRef} className="relative flex min-h-0 flex-1 flex-col">
        <PullToRefreshIndicator pull={pull} />

        {/* 引っ張りに追従して下がるのは<ul>だけでなく固定セクションも含めた中身全体。
            片方だけ下げると、引いている最中に固定セクションと一覧の境目が割れて見える */}
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{
            transform: pull.distance > 0 ? `translateY(${pull.distance}px)` : undefined,
            transition: pull.isDragging ? "none" : "transform 0.2s ease-out",
          }}
        >
          {pinnedSection}

          {/* 保留中で一覧から外したぶんの1行（#2398）。**件数には足さず、消えたことだけを伝える**
              ——マージ待ちPRが「CI・判定の完了待ちが3件あります」を件数に足さずに出しているのと
              同じ扱い（#2081）。「表示」で開くと、その場で解除できる */}
          {snoozeEnabled && snoozedTotal > 0 && (
            <div className={cn(COUNT_BAR_CLASS, "bg-slate-500/5")}>
              <p className={cn(COUNT_BAR_TEXT_CLASS, "flex items-center gap-1.5")}>
                <Clock className="size-3 shrink-0" />
                <span>
                  保留中が
                  <span className="font-medium text-foreground tabular-nums">{snoozedTotal}件</span>
                  あります（{describeSnoozeResume(snoozedEntries, now)}）
                </span>
              </p>
              <div className={COUNT_BAR_ACTIONS_CLASS}>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  aria-expanded={isSnoozedOpen}
                  onClick={() => setIsSnoozedOpen((open) => !open)}
                >
                  {isSnoozedOpen ? "隠す" : "表示"}
                </Button>
              </div>
            </div>
          )}
          {snoozeEnabled && isSnoozedOpen && (
            <div className="border-b bg-slate-500/5">
              {snoozedPinned?.section}
              <ul>{snoozedIssues.map(renderSnoozedRow)}</ul>
            </div>
          )}

          {issues.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              該当するIssueがありません
            </div>
          ) : (
            // relativeは各行のoffsetTopの基準を<ul>自身にするために必要（#773）。付けないと
            // offsetParentが外側の要素（スマホならMobileIssueListScreenのルート）になり、
            // offsetTopにヘッダー・タブの高さが含まれてしまう（実測で145pxずれる）。
            // アンカーによる復元は保存時との差分を取るためこのずれが相殺されるが、保存済み位置が
            // 無いときの中央寄せ（computeCenteredIssueListScrollTop）は生のoffsetTopを使うため、
            // 基準を揃えないと同じ分だけ下にずれる。
            // flex-1・min-h-0は、包む枠（引っ張って更新のタッチを受ける枠）の中でも件数ぶんの
            // 高さまで伸びず、残りを埋めるだけにするために要る（#1665と同じ理由）。
            // 引っ張りに追従するtransformは1つ外の枠が持つ（#2175）。transformはoffsetTopに
            // 影響しないため、追従は上の2つと両立する。
            <ul
              ref={listRef}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-auto overscroll-contain",
                fabSpacing && "pb-20",
              )}
            >
              {isGrouped
                ? repoGroups!.flatMap((group) => [
                    <li key={`group-${group.repositoryFullName}`}>
                      <GroupHeader group={group} />
                    </li>,
                    ...group.issues.map((issue) => renderIssueRow(issue, false)),
                  ])
                : issues.map((issue) => renderIssueRow(issue, true))}
              {/* MobileBottomNavのnav（min-h-14）と同じ高さの空白。ボトムナビは通常フローの
                  兄弟要素で本来重ならないはずだが、実機では末尾のIssueがフッターに隠れて
                  見えない事象が報告されたため、スクロールで確実に隠れずに表示できるよう
                  保険として同じ高さの空白ボックスを追加する（#677） */}
              {footerSpacing && <li aria-hidden className="h-14 shrink-0" />}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
