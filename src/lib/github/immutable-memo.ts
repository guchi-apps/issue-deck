/**
 * 結果が二度と変わらないGitHubの取得を、プロセス内で覚えておく小さなLRU（#5382）。
 *
 * 2つのコミットSHAの比較（`compare/{sha}...{sha}`）は、どちらもSHAで指している限り結果が変わらない。
 * 巡回が同じ組を数分おきに取り直していたため（本番の実測で同じ組が1時間に11回）、ここで覚えて返す。
 * ブランチ名を含む比較は先端が動くので**載せない**（呼び出し側が`isCommitSha`で確かめる）。
 *
 * ETagの条件付きGET（`conditional-request.ts`）を使わないのは、compareの応答本文（ファイル一覧・
 * コミット一覧）が大きく、使う部分だけを持てば足りるため。再起動で消えても次の1回が取り直すだけ。
 */
export class ImmutableMemo<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // 参照したものを新しい側へ寄せる（LRU）
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 40桁の16進（完全なコミットSHA）か。短縮SHAやブランチ名は指す先が変わりうるので含めない */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}
