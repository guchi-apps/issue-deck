import { CHECK_USER_LABEL, type CheckUserReason } from "@/lib/github/approval-labels";
import { sessionStallTitle } from "@/lib/dispatch/session-stall";
import type { ConflictCheckUserTimelineEvent } from "@/lib/github/conflict-check-user-clear";
import { deriveMergeHold } from "@/lib/pull-request-merge-hold";
import type { PullRequestSummary } from "@/types/pull-request";
import {
  parseSessionInterruptedReason,
  type SessionInterruptedReason,
} from "@/lib/dispatch/session-state";

/**
 * PR詳細の「止まった原因」（#5080）。
 *
 * 自動マージの見込みの帯は、対応Issueの`00.check-user`と理由ラベル（`01.check-*`）しか読めず、
 * `01.check-blocked`は「作業が止まっています」という固定文言にしかならなかった。**なぜ止まったか**は
 * Issueコメント（セッションの引き上げなど）にだけ残っていたため、そこから読める範囲をPR画面へ出す。
 *
 * **推測で補わない。** 原因として採るのは、`00.check-user`が最後に付いた時刻の前後にある、
 * issue-deck自身が固定の形で書く記録（マーカー付きのコメント）か、それ自体が原因を表す理由ラベルだけ。
 * 自由文のエージェントコメントは読まず、記録が無い・候補が複数ある・取得できないときは
 * 「直接原因を確認できません」として、調べる場所だけを返す。**自動マージの判定は再実装しない**
 * （阻止条件は対応Issueの`00.check-user`で、それはこれまでどおり`requiresUserMerge`等が読む）。
 */

/**
 * GitHubの`/issues/{number}/timeline`のうち、この判定が読むフィールド。コンフリクト解消の確認待ち
 * 解除（`conflict-check-user-clear.ts`）と同じ型に、記録の時刻とURLを足したもの。付与時刻は
 * DBの`checkUserLabeledAt`（同期した時刻）ではなく、timelineの並びと時刻から読む（#4931と同じ理由）
 */
export type StopCauseTimelineEvent = ConflictCheckUserTimelineEvent & {
  created_at?: string;
  /** `commented`のURL */
  html_url?: string;
};

export type StopCauseLink = { label: string; url: string };

/** 原因が特定できたときの中身 */
export type IdentifiedStopCause = {
  status: "identified";
  /** 何が起きたか（1文） */
  title: string;
  /** いま必要な操作（順に行うもの） */
  actions: string[];
  /** 記録の出所の説明（「セッション引き上げコメント」「理由ラベル`01.check-plan`」など） */
  sourceLabel: string;
  /** 記録へのURL。ラベルが出所のときはnull */
  sourceUrl: string | null;
  /** 記録の時刻（ISO8601）。読めなければnull */
  sourceAt: string | null;
  /** Issue詳細の「セッションが停滞しています」パネルから続きを送れる原因か */
  stallPanel: boolean;
};

export type UnidentifiedStopCause = {
  status: "unidentified";
  /** `no-record`＝原因として読める記録が無い・`multiple`＝候補が複数・`fetch-failed`＝取得できない */
  why: "no-record" | "multiple" | "fetch-failed";
  /** 調べる場所 */
  investigate: StopCauseLink[];
};

export type PullRequestStopCause = {
  issueNumber: number;
  issueUrl: string;
  /** 対応Issueに`00.check-user`が最後に付いた時刻（ISO8601）。記録から読めなければnull */
  labeledAt: string | null;
  /** 直近の自動マージ判定（`auto-merge`ジョブ）。check-runが無ければnull */
  judgement: { url: string | null; completedAt: string | null } | null;
  cause: IdentifiedStopCause | UnidentifiedStopCause;
};

/**
 * 付与時刻より前の記録を、どこまで同じ付与の原因として扱うか。引き上げはコメントの投稿→ラベルの
 * 付与の順で数秒以内に行うが、GitHub側の遅れを見込んで幅を持たせる。前回の解除より前は見ない。
 */
const CAUSE_WINDOW_MS = 10 * 60 * 1000;

const SESSION_INTERRUPTED_MARKER = "<!-- supervisor:session-interrupted -->";
const SESSION_FAILED_MARKER = "<!-- supervisor:session-failed -->";
const SESSION_NOT_STARTED_MARKER = "<!-- supervisor:session-not-started -->";
const STALL_REASON_PATTERN = /<!-- issue-deck:stall-reason:([a-z_]+) -->/;

/**
 * 種別マーカーが無い（#5080より前の）引き上げコメントを、1行目の固定文言から読む。
 * 文言は`buildSessionInterruptedCommentBody`が書くもの。一致しなければ種別は不明のまま扱う。
 */
const LEGACY_REASON_LEADS: readonly [string, SessionInterruptedReason][] = [
  ["ツールを呼び出そうとした形跡", "tool_call_stall"],
  ["計画を提示せずに応答を終えています", "plan_not_presented"],
  ["文章での問いかけで応答を終えています", "question_asked"],
  ["クラシファイアにコマンドを拒否されたまま", "classifier_blocked"],
  ["ターンを完了しないまま止まっています", "turn_stall"],
  ["APIエラーで中断したまま止まっています", "api_error"],
];

const STALL_ACTIONS: Record<SessionInterruptedReason, string[]> = {
  api_error: ["Issue詳細の停滞パネルから、中断したところから続けるよう送ります"],
  tool_call_stall: ["Issue詳細の停滞パネルから、ツールが呼ばれていないと伝える文面を送ります"],
  turn_stall: [
    "Issue詳細の停滞パネルから、中断したところから続けるよう送ります",
    "変わらなければ端末でCodexの様子を見て、起こし直します",
  ],
  question_asked: ["セッションの末尾の問いかけを端末かRemote Controlで確かめ、回答を送ります"],
  plan_not_presented: ["Issue詳細の停滞パネルから、計画を提示するよう送ります（承認は提示後に行います）"],
  classifier_blocked: [
    "拒否されたコマンドを端末で許可するか、人が代わりに実行するか、別の手段で進めるよう指示します（「進めて」だけでは解けません）",
  ],
};

/** 停滞パネルから送れば外れるが、端末から続けた場合は手で外す必要がある旨 */
const STALL_CLEAR_ACTION =
  "続きを送ったら`00.check-user`を外します（Issue詳細の停滞パネルから送れば自動で外れます）";

type CommentCause = Omit<IdentifiedStopCause, "status" | "sourceUrl" | "sourceAt"> & {
  /** 同じ原因の重複を1つに数えるためのキー */
  key: string;
};

function commentCause(body: string): CommentCause | null {
  if (body.includes(SESSION_INTERRUPTED_MARKER)) {
    const reason =
      parseSessionInterruptedReason(body.match(STALL_REASON_PATTERN)?.[1]) ??
      LEGACY_REASON_LEADS.find(([lead]) => body.split("\n", 2).join("").includes(lead))?.[1] ??
      null;
    if (reason === null) {
      // 引き上げであることは確かだが、種別を読めない。見出しを推測せず、確かな範囲だけを書く
      return {
        key: "interrupted",
        title: "実装セッションが停滞したまま止まっていると引き上げられました（種別は記録から読めません）",
        actions: ["Issueの引き上げコメントで続け方を確かめます", STALL_CLEAR_ACTION],
        sourceLabel: "セッション引き上げコメント",
        stallPanel: true,
      };
    }
    return {
      key: `interrupted:${reason}`,
      title: sessionStallTitle(reason),
      actions: [...STALL_ACTIONS[reason], STALL_CLEAR_ACTION],
      sourceLabel: "セッション引き上げコメント",
      stallPanel: true,
    };
  }
  if (body.includes(SESSION_FAILED_MARKER)) {
    return {
      key: "failed",
      title: "実装セッションが異常終了しました",
      actions: [
        "端末（`tmux attach`）で最後の出力を確かめます",
        "続ける場合は`scripts/start-issue.sh <番号>`で再開します",
      ],
      sourceLabel: "セッション異常終了の通知コメント",
      stallPanel: false,
    };
  }
  if (body.includes(SESSION_NOT_STARTED_MARKER)) {
    return {
      key: "not-started",
      title: "Claude Codeが起動時の確認（フォルダの信頼確認など）で止まっています",
      actions: [
        "端末から起動時の確認に答えます（Remote Controlからは答えられません）",
        "答えると`00.check-user`は自動で外れます",
      ],
      sourceLabel: "セッション未開始の通知コメント",
      stallPanel: false,
    };
  }
  return null;
}

/** 理由ラベルそのものが原因を表すもの。`blocked`は「止まった」としか言えないので含めない */
const LABEL_CAUSES: Partial<Record<CheckUserReason, { title: string; actions: string[] }>> = {
  plan: {
    title: "実装セッションが計画を提示し、承認を待っています",
    actions: ["Issue詳細で計画を読み、承認するか修正を送ります"],
  },
  input: {
    title: "実装セッションが質問への回答を待っています",
    actions: ["Issue詳細か端末で質問に答えます"],
  },
  answered: {
    title: "質問には回答済みで、内容の確認を待っています",
    actions: ["Issueのやり取りを確かめ、問題なければ`00.check-user`を外します"],
  },
};

function isCheckUserEvent(event: StopCauseTimelineEvent, kind: "labeled" | "unlabeled"): boolean {
  return event.event === kind && event.label?.name === CHECK_USER_LABEL;
}

function timeOf(event: StopCauseTimelineEvent): number {
  return event.created_at ? Date.parse(event.created_at) : Number.NaN;
}

/**
 * 対応Issueのtimelineから、`00.check-user`が付いている直接原因を決める（#5080）。
 *
 * timelineの最後の`00.check-user`操作が解除なら、DBのラベルキャッシュより新しい情報として
 * **ラベルは外れている**と読み、`null`を返す（古い原因を今のものとして出さない）。
 *
 * @param timeline GitHubが返す順（古い順）
 */
export function resolveStopCause(input: {
  timeline: readonly StopCauseTimelineEvent[];
  checkReason: CheckUserReason | null;
}): { labeledAt: string | null; cause: IdentifiedStopCause | UnidentifiedStopCause } | null {
  const { timeline } = input;
  const labeledIndex = timeline.findLastIndex((event) => isCheckUserEvent(event, "labeled"));
  const unlabeledIndex = timeline.findLastIndex((event) => isCheckUserEvent(event, "unlabeled"));
  if (unlabeledIndex > labeledIndex) return null;

  const labeledEvent = labeledIndex >= 0 ? timeline[labeledIndex] : null;
  const labeledAt = labeledEvent?.created_at ?? null;
  const labeledMs = labeledEvent ? timeOf(labeledEvent) : Number.NaN;
  const lowerMs = Math.max(
    unlabeledIndex >= 0 ? timeOf(timeline[unlabeledIndex]) : Number.NEGATIVE_INFINITY,
    Number.isNaN(labeledMs) ? Number.NEGATIVE_INFINITY : labeledMs - CAUSE_WINDOW_MS,
  );

  // 付与の前後（前回の解除より後）にある、固定の形の記録だけを候補にする。付与の後に来たものも
  // 含めるのは、ラベルが付いたまま別の原因で引き上げられた場合（ラベルの再付与は記録されない）のため
  const found = new Map<string, IdentifiedStopCause>();
  timeline.forEach((event, index) => {
    if (event.event !== "commented" || index <= unlabeledIndex) return;
    const at = timeOf(event);
    if (!Number.isNaN(at) && at < lowerMs) return;
    const cause = commentCause(event.body ?? "");
    if (!cause) return;
    const { key, ...rest } = cause;
    // 同じ原因の再投稿は最新を採る
    found.set(key, {
      status: "identified",
      ...rest,
      sourceUrl: event.html_url ?? null,
      sourceAt: event.created_at ?? null,
    });
  });

  if (found.size === 1) return { labeledAt, cause: [...found.values()][0] };
  if (found.size > 1) {
    return {
      labeledAt,
      cause: {
        status: "unidentified",
        why: "multiple",
        investigate: [...found.values()].flatMap((cause) =>
          cause.sourceUrl ? [{ label: cause.sourceLabel, url: cause.sourceUrl }] : [],
        ),
      },
    };
  }

  const labelCause = input.checkReason ? LABEL_CAUSES[input.checkReason] : undefined;
  if (labelCause && input.checkReason) {
    const reasonLabel = `01.check-${input.checkReason}`;
    const reasonEvent = timeline.findLast(
      (event) => event.event === "labeled" && event.label?.name === reasonLabel,
    );
    return {
      labeledAt,
      cause: {
        status: "identified",
        ...labelCause,
        sourceLabel: `理由ラベル\`${reasonLabel}\``,
        sourceUrl: null,
        sourceAt: reasonEvent?.created_at ?? labeledAt,
        stallPanel: false,
      },
    };
  }

  // 記録が無い。付与の直前のコメントを調べる場所として示す（中身は読まない）
  const lastCommentBefore = timeline
    .slice(0, labeledIndex >= 0 ? labeledIndex : timeline.length)
    .findLast((event) => event.event === "commented" && event.html_url);
  return {
    labeledAt,
    cause: {
      status: "unidentified",
      why: "no-record",
      investigate: lastCommentBefore?.html_url
        ? [{ label: "ラベル付与の直前のコメント", url: lastCommentBefore.html_url }]
        : [],
    },
  };
}

/**
 * 「止まった原因」を引く対象のPRか（#5080）。自動マージの見込みの帯が対応Issueの`00.check-user`を
 * 理由に挙げている（`deriveMergeHold`）ときに限る。理由が`merge`（自動レビューがマージ前の確認を
 * 求めた）のときは、既存の「ユーザーのマージが必要な理由」（#4088）が理由コメントを出すので除く。
 */
export function shouldResolveStopCause(pullRequest: PullRequestSummary): boolean {
  if (pullRequest.linkedIssueCheckReason === "merge") return false;
  return deriveMergeHold(pullRequest).reasons.some((reason) => reason.kind === "check-user");
}
