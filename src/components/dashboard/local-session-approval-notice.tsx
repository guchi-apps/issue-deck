"use client";

import { ExternalLink, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * サブPC・手元で走っているIssueの承認欄に出す案内（#1264）。
 *
 * **承認コメントを投稿しても、`11.local`が付いている間は無人実行が反応しない。** そのため
 * 「計画を承認」を押しても何も起きない（コメントだけが残る）。押す前にそれが分かるようにし、
 * 実際の承認の出口であるRemote Controlへ誘導する。
 *
 * ボタンにしないのは、**画面から入力そのものを送らない**という取り決めのため
 * （`docs/multi-agent/gates.md`。`send-keys`で選択フォームに誤答させた事故がある）。
 * ここが持てるのは「開く」までで、答えるのはRemote Control側。
 */
export function LocalSessionApprovalNotice({
  session,
}: {
  /** 対応するセッション。見つかっていなければ`null`（案内だけ出す） */
  session: DispatchSessionView | null;
}) {
  const remoteControlUrl = session ? summarizeIssueSession(session).remoteControlUrl : null;

  return (
    <div className="mb-2 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          このIssueはローカル（サブPCまたは手元）で対応中です。
          <strong className="font-medium">下のボタンで承認してもコメントが残るだけで、
          走っているセッションは動きません</strong>
          （`11.local`が付いている間、無人実行は反応しません）。セッションへ答えるには
          Remote Controlを開いてください。
        </span>
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
