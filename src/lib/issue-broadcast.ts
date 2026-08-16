import type { Issue } from "@/types/issue";

/**
 * 同じブラウザで開いている他のIssueDeckの画面へ「Issueを作った」ことを伝える（#1728）。
 *
 * 別ウィンドウ（`/issues/new`）で作ったIssueは、元のデッキ側のstateには入らない。
 * 一覧のポーリング（`use-issue-polling`・10秒間隔）でいずれ現れるが、作った直後に
 * 一覧へ出ていないと、作れたのかどうかが押した本人から見えない。
 *
 * **元のデッキで選択中のIssueは切り替えない。** 別ウィンドウで書いているのは
 * 「デッキを見ながら書く」ためで、作成のたびに見ていた画面を奪うと目的と逆になる。
 * 選択を動かすのは、その画面自身で作成したとき（`handleIssueCreated`）だけにする。
 */
const ISSUE_CREATED_CHANNEL = "issue-deck:issue-created";

/** 送信元自身には届かない（BroadcastChannelの仕様）ので、送った側の重複追加は考えなくてよい */
export function broadcastIssueCreated(issue: Issue): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(ISSUE_CREATED_CHANNEL);
  channel.postMessage(issue);
  channel.close();
}

export function subscribeIssueCreated(onCreated: (issue: Issue) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(ISSUE_CREATED_CHANNEL);
  channel.onmessage = (event: MessageEvent<Issue>) => onCreated(event.data);
  return () => channel.close();
}
