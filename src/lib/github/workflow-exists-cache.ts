import { fetchWorkflowExists } from "@/lib/github/release-api";

/**
 * ワークフローファイルの有無をプロセス内にキャッシュする（#2020）。
 *
 * `workflow_dispatch`の受け口はファイルの実在で決まるため、**ファイル名だけで**
 * 「画面のボタンから起動できるか」を判定できる（`fetchWorkflowExists`）。この判定は
 * リリース（#1538）・自動修復（#1960）・本番デプロイ（#2020）がそれぞれ持っていたが、
 * 中身が同じキャッシュを3つ並べても消費が3倍になるだけなので1か所へ寄せている。
 *
 * 本番はPM2のfork（単一プロセス）で動作し、プロセスが入れ替わればキャッシュは空になる。
 */
const WORKFLOW_EXISTS_TTL_MS = 10 * 60_000;

const cache = new Map<string, { exists: boolean; cachedAt: number }>();

/**
 * 同じワークフローへの問い合わせが重ならないようにするための実行中のPromise。
 * 1回のPR一覧の取得で、同じリポジトリの同じファイルを複数のPR・複数の種類が同時に見にくる
 * （`claude-pr-repair.yml`はCI失敗とコンフリクトの両方の起動先）。
 */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * ワークフローの有無を、プロセス内キャッシュと実行中リクエストの共有ごしに返す。
 *
 * `missingTtlMs`を渡すと**無い側だけ**を短く持つ（既定は有る側と同じ10分）。配布PRが
 * マージされた瞬間に偽から真へ変わる値では、10分持つと「配ったのにボタンが押せない」時間が
 * できるため（#1960）。逆向き（真→偽）は起こらないので有る側は常に10分でよい。
 */
export function workflowExists(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
  options: { missingTtlMs?: number } = {},
): Promise<boolean> {
  const key = `${owner}/${repo}/${workflowFile}`;
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.exists
      ? WORKFLOW_EXISTS_TTL_MS
      : (options.missingTtlMs ?? WORKFLOW_EXISTS_TTL_MS);
    if (Date.now() - cached.cachedAt < ttl) return Promise.resolve(cached.exists);
  }

  const running = inFlight.get(key);
  if (running) return running;

  const request = fetchWorkflowExists(owner, repo, workflowFile, token)
    .then((exists) => {
      cache.set(key, { exists, cachedAt: Date.now() });
      return exists;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** テスト用にキャッシュを空にする（プロセスをまたがないので本番では呼ばない） */
export function clearWorkflowExistsCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}
