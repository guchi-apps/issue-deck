// ghのバージョンに依存する--slurpを使わず、RESTのページを明示して取得する。
export function listOpenPullRequests(gh, repository) {
  const prs = new Map();
  for (let page = 1; ; page += 1) {
    let items;
    try {
      items = gh(`repos/${repository}/pulls?state=open&base=develop&per_page=100&page=${page}`);
    } catch {
      // stderrには資格情報が含まれる可能性があるため、処理とページだけを記録する。
      throw new Error(`iOS検証: PR一覧取得に失敗しました（page=${page}）。ghの認証・接続を確認してください`);
    }
    if (!Array.isArray(items)) throw new Error('iOS検証: PR一覧の応答が配列ではありません');
    for (const pr of items) prs.set(pr.number, pr);
    if (items.length < 100) return [...prs.values()];
  }
}
