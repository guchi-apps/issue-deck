import { parseDispatchHostRepositories } from "@/lib/dispatch/dispatch-job";
import { db } from "@/lib/db";

/**
 * サブPCのローカルセッションで起動できると申告されているリポジトリの集合（#1888）。
 *
 * 申告の実体は`DispatchHost.repositories`（サブPCが`~/.config/issue-deck/local-repos.conf`を
 * 走査して`POST /api/dispatch/hosts`で送るもの。`announceDispatchHost`）。**画面のリポジトリ
 * 一覧に「どちらの実行経路にも対応していない」印を出すかの判定に使う。**
 *
 * **ホストが応答しているか（`isDispatchHostOnline`）は見ず、申告のあるホストすべての和を取る。**
 * 起動先を選ばせる`resolveDispatchTargetRejection`とは目的が違い、こちらは押す前の可否ではなく
 * リポジトリの構成の表示なので、サブPCがスリープしているあいだだけ印が付くのは誤りに見える。
 * 実際に押せるかどうかは、押す時点でIssue詳細側が改めて判定する。
 */
export async function listDispatchRunnableRepositories(): Promise<Set<string>> {
  const hosts = await db.dispatchHost.findMany({ select: { repositories: true } });
  const runnable = new Set<string>();
  for (const host of hosts) {
    for (const fullName of parseDispatchHostRepositories(host.repositories)) {
      runnable.add(fullName);
    }
  }
  return runnable;
}
