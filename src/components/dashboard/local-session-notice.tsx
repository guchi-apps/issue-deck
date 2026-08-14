"use client";

import { ExternalLink, Info } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * ローカル（サブPCまたは手元）で走っているIssueの画面に出す案内（#1264・#1287）。
 *
 * **`11.local`が付いている間、Issueへ何を書いても無人実行は反応しない。** 走っている
 * Claude Code自身にもコメントを取りに行く仕組みは無いので、書いた内容は誰にも届かないまま
 * 残る。押す前・書く前にそれが分かるようにし、実際の出口であるRemote Controlへ誘導する。
 *
 * ボタンにしないのは、**画面から入力そのものを送らない**という取り決めのため
 * （`docs/multi-agent/gates.md`。`send-keys`で選択フォームに誤答させた事故がある）。
 * ここが持てるのは「開く」までで、答えるのはRemote Control側。
 *
 * 承認欄（`LocalSessionApprovalNotice`）とコメント入力欄（`LocalSessionCommentNotice`）で
 * 文面だけが違う。**枠と導線を1つに保つ**ため、外側はこの内部コンポーネントで共有する。
 */
function LocalSessionNotice({
  session,
  children,
}: {
  session: DispatchSessionView | null;
  children: ReactNode;
}) {
  const remoteControlUrl = session ? summarizeIssueSession(session).remoteControlUrl : null;

  return (
    <div className="mb-2 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>{children}</span>
      </p>
      {remoteControlUrl && (
        <Button variant="outline" size="sm" className="mt-2" asChild>
          <a href={remoteControlUrl} target="_blank" rel="noreferrer">
            Remote Controlで開く
            <ExternalLink />
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * 承認欄に出す案内（#1264）。
 *
 * **承認コメントを投稿しても、`11.local`が付いている間は無人実行が反応しない。** そのため
 * 「計画を承認」を押しても何も起きない（コメントだけが残る）。
 */
export function LocalSessionApprovalNotice({
  session,
}: {
  /** 対応するセッション。見つかっていなければ`null`（案内だけ出す） */
  session: DispatchSessionView | null;
}) {
  return (
    <LocalSessionNotice session={session}>
      このIssueはローカル（サブPCまたは手元）で対応中です。
      <strong className="font-medium">
        下のボタンで承認してもコメントが残るだけで、走っているセッションは動きません
      </strong>
      （`11.local`が付いている間、無人実行は反応しません）。セッションへ答えるには Remote
      Controlを開いてください。
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
