import { db } from "@/lib/db";

/**
 * リポジトリ名の変更履歴（#3613）。`SessionUsage.repository`は改名前の行が旧名のまま残るので、
 * 「AI使用量」の集計が旧名を現在の名前へ寄せて読む。行そのものは書き換えない（旧名のworktreeで
 * 走るセッションの再報告で上書き戻されるため）。
 *
 * **記録が走るのはリポジトリの同期が`Repository.name`を上書きするとき**で、同期は手動
 * （設定＞フリート運用の「GitHubからの再取得」・App導入・新規アプリ立ち上げ）。改名後に再同期
 * するまでは新名の行が別リポジトリとして表示され、再同期で遡って合算される。
 */

/**
 * 旧名→現在名の対応表を引く関数を作る。
 *
 * - **現存する名前は解決しない**（`currentNames`）。旧名が別リポジトリの名前として再利用された
 *   とき、新しいリポジトリの使用量を改名先へ合算しないため
 * - A→B→Cのような連鎖は辿る。循環は打ち切り、その時点の名前を返す
 */
export function buildRepositoryNameResolver(
  aliases: { oldName: string; newName: string }[],
  currentNames: Iterable<string>,
): (name: string) => string {
  const current = new Set(currentNames);
  const next = new Map(aliases.map((alias) => [alias.oldName, alias.newName]));

  return (name) => {
    const seen = new Set<string>();
    let resolved = name;
    while (!current.has(resolved) && next.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      resolved = next.get(resolved) as string;
    }
    return resolved;
  };
}

/** DBの履歴と現存リポジトリ名から、集計用の解決関数を作る */
export async function loadRepositoryNameResolver(): Promise<(name: string) => string> {
  const [aliases, repositories] = await Promise.all([
    db.repositoryNameAlias.findMany({ select: { oldName: true, newName: true } }),
    db.repository.findMany({ select: { name: true } }),
  ]);
  return buildRepositoryNameResolver(
    aliases,
    repositories.map((repository) => repository.name),
  );
}

/**
 * 改名を記録する。`oldName`でupsertするので、同じ改名を再び記録しても（初期投入済みの
 * myroom→kurashioを再同期が記録し直すなど）一意制約で落ちない。
 * **失敗しても握る**——記録は集計の補助で、同期・Webhook本体を止めない。
 */
export async function recordRepositoryRename(input: {
  githubRepositoryId: number;
  oldName: string;
  newName: string;
}): Promise<void> {
  if (input.oldName === input.newName) return;
  try {
    await db.repositoryNameAlias.upsert({
      where: { oldName: input.oldName },
      create: input,
      update: { githubRepositoryId: input.githubRepositoryId, newName: input.newName },
    });
  } catch (error) {
    console.error(
      `[repository-alias] 改名の記録に失敗: ${input.oldName} → ${input.newName}`,
      error,
    );
  }
}
