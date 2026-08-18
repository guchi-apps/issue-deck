import {
  resolveRepairDispatch,
  type RepairKind,
  type RepairTargetPullRequest,
  type RepairWorkflowAvailability,
} from "@/lib/github/pull-request-repair";
import { fetchWorkflowExists } from "@/lib/github/release-api";

/**
 * 自動修復ワークフロー（`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・
 * `claude-pr-repair.yml`）が配られているかは、配布PRがマージされる時にしか変わらない。
 * PRの取得のたびに問い合わせず、`releaseWorkflowExists`と同じ形でプロセス内にキャッシュする。
 * 本番はPM2のfork（単一プロセス）で動作し、プロセスが入れ替わればキャッシュは空になる。
 */
const REPAIR_WORKFLOW_EXISTS_TTL_MS = 10 * 60_000;
const repairWorkflowExistsCache = new Map<string, { exists: boolean; cachedAt: number }>();

/**
 * 同じワークフローへの問い合わせが重ならないようにするための実行中のPromise。
 * 1回のPR一覧の取得で、同じリポジトリの同じファイルを複数のPR・複数の種類が同時に見にくる
 * （`claude-pr-repair.yml`はCI失敗とコンフリクトの両方の起動先）。
 */
const inFlight = new Map<string, Promise<boolean>>();

async function workflowExists(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
): Promise<boolean> {
  const key = `${owner}/${repo}/${workflowFile}`;
  const cached = repairWorkflowExistsCache.get(key);
  if (cached && Date.now() - cached.cachedAt < REPAIR_WORKFLOW_EXISTS_TTL_MS) {
    return cached.exists;
  }

  const running = inFlight.get(key);
  if (running) return running;

  const request = fetchWorkflowExists(owner, repo, workflowFile, token)
    .then((exists) => {
      repairWorkflowExistsCache.set(key, { exists, cachedAt: Date.now() });
      return exists;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/**
 * このPRに出す修復ボタンの種類ごとに、起動先ワークフローが対象リポジトリにあるか（#1960）。
 *
 * **ボタンを出す種類（`repairKindsFor`の結果）だけを渡すこと。** 出さない種類まで問い合わせると、
 * 画面に現れない判定のためにGitHub APIを消費する。
 *
 * 判定に失敗した種類はキーごと落とし、押せるままにする（`RepairWorkflowAvailability`）。
 * 存在確認が404以外で落ちるのは権限・障害といった一時的な理由で、そこでボタンを無効化すると
 * 「配ってあるのに押せない」状態になるため。
 */
export async function fetchRepairWorkflowAvailability(
  owner: string,
  repo: string,
  pullRequest: RepairTargetPullRequest,
  kinds: RepairKind[],
  token: string,
): Promise<RepairWorkflowAvailability> {
  if (kinds.length === 0) return {};

  const availability: RepairWorkflowAvailability = {};
  await Promise.all(
    kinds.map(async (kind) => {
      const { workflowFile } = resolveRepairDispatch(pullRequest, kind);
      try {
        availability[kind] = await workflowExists(owner, repo, workflowFile, token);
      } catch (error) {
        console.warn(
          `[repair-workflow-cache] ${owner}/${repo} ${workflowFile} の有無を判定できませんでした:`,
          error,
        );
      }
    }),
  );
  return availability;
}

/** テスト用にキャッシュを空にする（プロセスをまたがないので本番では呼ばない） */
export function clearRepairWorkflowExistsCacheForTest(): void {
  repairWorkflowExistsCache.clear();
  inFlight.clear();
}
