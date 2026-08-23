"use client";

import { ExternalLink, Info } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * ローカル（サブPCまたは手元）で走っているIssueの画面に出す案内（#1264・#1287）。
 *
 * **`11.local`が付いている間、Issueへ何を書いても無人実行は反応しない。** 走っている
 * Claude Code自身にもコメントを取りに行く仕組みは無いので、書いた内容は誰にも届かないまま
 * 残る。押す前・書く前にそれが分かるようにし、実際の出口であるRemote Controlへ誘導する。
 *
 * ここから送る導線を持たないのは、**答えを選ばせる操作（選択肢の確定）を画面から行わない**
 * という取り決めのため（`docs/multi-agent/gates.md`。`send-keys`で選択フォームに誤答させた
 * 事故がある）。ここが持てるのは「開く」までで、答えるのはRemote Control側。
 *
 * **入力待ちでないセッションへ1行の追加指示を流すのは別の導線にある**（#1012。Issue詳細の
 * セッション表示の「追加指示を送る」）。あちらは承認プロンプト・選択フォームの表示中は
 * 送らずに見送るため、ここが受け持つ「答える」とは重ならない。
 *
 * 承認欄（`LocalSessionApprovalNotice`）とコメント入力欄（`LocalSessionCommentNotice`）で
 * 文面だけが違う。**枠と導線を1つに保つ**ため、外側はこの内部コンポーネントで共有する。
 */
function LocalSessionNotice({
  session,
  children,
  /**
   * Remote Controlのボタンを塗りつぶし（主導線）にするか（#1903）。
   *
   * 承認欄では、そこにある他のボタンがどれもセッションへ届かない。**枠の中で唯一効く操作**が
   * これなので、承認欄でだけ主導線として出す。コメント入力欄の案内は「記録として残すだけなら
   * そのままでよい」場面なので、従来どおり枠線のまま。
   */
  emphasizeRemoteControl = false,
  /** Remote Controlボタンの文言。承認欄では「答える」ことが用件なので言い換える */
  remoteControlLabel = "Remote Controlで開く",
}: {
  session: DispatchSessionView | null;
  children: ReactNode;
  emphasizeRemoteControl?: boolean;
  remoteControlLabel?: string;
}) {
  const remoteControlUrl = session ? summarizeIssueSession(session).remoteControlUrl : null;

  return (
    <div className="mb-2 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>{children}</span>
      </p>
      {remoteControlUrl && (
        <Button
          variant={emphasizeRemoteControl ? "default" : "outline"}
          size="sm"
          className="mt-2"
          asChild
        >
          <a href={remoteControlUrl} target="_blank" rel="noreferrer">
            {remoteControlLabel}
            <ExternalLink />
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * 承認欄に出す案内（#1264・#1903）。
 *
 * **承認コメントを投稿しても、`11.local`が付いている間は無人実行が反応しない。** そのため
 * 「計画を承認」を押しても何も起きない（コメントだけが残る）。
 *
 * #1903で、セッションが生きているかどうかで言い方を分けた。「動きません」だけでは、
 * 答える先がまだあるのか（Remote Control）、もう居ないのか（復旧が要る）が読み取れない。
 * あわせて、承認欄のボタンから「承認」「修正」を外して「コメント」「質問する」
 * 「確認待ちを外す」に変えた（`comment-thread.tsx`）ため、押すと何が起きるかもここで言う。
 */
export function LocalSessionApprovalNotice({
  session,
}: {
  /** 対応するセッション。見つかっていなければ`null`（案内だけ出す） */
  session: DispatchSessionView | null;
}) {
  const hostName = session ? formatDispatchHostName(session.host) : null;

  // セッションの記録そのものが無い（24時間で落ちた・pollerの外で起こした）。**終了したとは
  // 言い切らない。** 復旧ボタンもセッションの行が無ければ出ないので、そこへは送らない
  if (session === null) {
    return (
      <LocalSessionNotice session={null}>
        このIssueはローカル（サブPCまたは手元）で対応中です。
        <strong className="font-medium">ここでの操作は走っているセッションには届きません</strong>
        （`11.local`が付いている間、無人実行も反応しません）。「確認待ちを外す」を押しても、
        コメントが記録として残り確認待ちの印が外れるだけです。
      </LocalSessionNotice>
    );
  }

  // 終わったセッションに「Remote Controlから答えてください」と言わない（開いても繋がらない）。
  // 出口は復旧（`SessionRecoveryButton`。押す場所はセッションの行の下にある）
  if (session.state !== "ALIVE") {
    return (
      <LocalSessionNotice session={session}>
        このIssueを担当していた{hostName}のセッションは
        <strong className="font-medium">終了しています</strong>
        。ここでの操作では作業は再開しません（コメントは記録として残ります）。続きを頼むには
        「セッションを復旧」から起こし直してください。
      </LocalSessionNotice>
    );
  }

  return (
    <LocalSessionNotice
      session={session}
      emphasizeRemoteControl
      remoteControlLabel="Remote Controlで答える"
    >
      {hostName}のセッションが担当中です。
      <strong className="font-medium">ここに書いた回答はセッションに届きません</strong>
      （`11.local`が付いている間、無人実行も反応しません）。「確認待ちを外す」を押しても、
      コメントが記録として残り確認待ちの印が外れるだけです。答えるにはRemote Controlを開いてください。
    </LocalSessionNotice>
  );
}

/**
 * 走っているセッションが今まさに入力を待っているときに、承認欄のボタンの代わりに出す案内（#1417）。
 *
 * `LocalSessionApprovalNotice`は「押しても動かない」ことを添えるだけでボタンは出すが、
 * **セッションが生きて入力待ちで止まっている間は、押して得られるものが何も無い**
 * （コメントは届かず、`00.check-user`はフックが人の応答を検知した時点で自動的に外れる）。
 * この状態でだけボタンを引っ込め、唯一効く出口であるRemote Controlに絞る。
 */
export function LocalSessionWaitingInputNotice({
  session,
  planDecisionPending = false,
  questionAnswerPending = false,
}: {
  /** 対応するセッション。見つかっていなければ`null`（案内だけ出す） */
  session: DispatchSessionView | null;
  /**
   * 計画への返事を画面から送れる状態か（#2061）。
   *
   * **このとき「Remote Controlから伝えてください」と言わない。** 承認・修正の出口はこの画面の
   * 上部（計画パネル）にあり、そちらを案内しないと**アプリで完結できること自体が画面から
   * 読み取れない**。計画待ち以外（質問・スクリーンショットの確認など）は従来どおり。
   */
  planDecisionPending?: boolean;
  /**
   * 質問への回答を画面から送れる状態か（#2189）。
   *
   * **計画待ちより先に見る。** 計画を出したあとに質問することはあり、そのとき待たれて
   * いるのは新しい方（質問）になる。
   */
  questionAnswerPending?: boolean;
}) {
  if (questionAnswerPending) {
    return (
      <LocalSessionNotice session={session} remoteControlLabel="Remote Controlで開く">
        質問の回答を待っています。
        <strong className="font-medium">
          上の「質問の回答を待っています」から選択肢を選んで送れます
        </strong>
        （このコメント欄へ書いても走っているセッションには届きません）。待ち時間が切れた後は
        Remote Controlか端末から答えてください。
      </LocalSessionNotice>
    );
  }

  if (planDecisionPending) {
    return (
      <LocalSessionNotice session={session} remoteControlLabel="Remote Controlで開く">
        計画の承認を待っています。
        <strong className="font-medium">
          上の「計画の承認を待っています」から承認・修正を送れます
        </strong>
        （このコメント欄へ書いても走っているセッションには届きません）。待ち時間が切れた後は
        Remote Controlか端末から伝えてください。
      </LocalSessionNotice>
    );
  }

  return (
    <LocalSessionNotice session={session}>
      走っているセッションが入力を待っています。
      <strong className="font-medium">承認・修正はRemote Controlから伝えてください</strong>
      （`11.local`が付いている間、このコメント欄へ書いても走っているセッションには届きません）。
      答えると`00.check-user`は自動的に外れます。
    </LocalSessionNotice>
  );
}

/**
 * コメント入力欄に出す案内（#1287）。
 *
 * 承認欄の案内は**承認待ちのときしか出ない**が、届かないのは承認コメントに限らない。
 * 実装中に追加の指示や訂正を書く方がむしろ多く、そちらは何の合図も無いまま埋もれる。
 */
export function LocalSessionCommentNotice({
  session,
}: {
  /** 対応するセッション。見つかっていなければ`null`（案内だけ出す） */
  session: DispatchSessionView | null;
}) {
  return (
    <LocalSessionNotice session={session}>
      このIssueはローカル（サブPCまたは手元）で対応中です。
      <strong className="font-medium">
        ここへ書いたコメントは、走っているセッションには届きません
      </strong>
      （`11.local`が付いている間、無人実行は反応しません）。記録として残すだけなら
      そのままで問題ありませんが、セッションへ指示を伝えるにはRemote Controlを開いてください。
    </LocalSessionNotice>
  );
}
