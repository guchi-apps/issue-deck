import { fetchWithTimeout, SLOW_FETCH_TIMEOUT_MS } from "@/lib/fetch-with-timeout";
import type { PropagationRun, SourceAhead, WorkflowTagStatus } from "@/lib/workflow-tags";

/** `/api/workflow-tags`の応答（#985・#4016） */
export type WorkflowTagsOverview = {
  latest: string | null;
  repositories: WorkflowTagStatus[];
  propagation: PropagationRun | null;
  /** 不足しているcallerの配布（#1948・#1475）。タグ配布とは別のrun */
  repairPropagation: PropagationRun | null;
  /** ワークフロー以外の配布物の更新（#2240）。これも別のrun */
  sharedFilePropagation: PropagationRun | null;
  /** 配布元（`main`）が最新タグからどれだけ進んでいるか（#2476）。取れなければ null */
  sourceAhead: SourceAhead | null;
  /** GitHubから読めず判定できなかったリポジトリ（#4016）。古いサーバーの応答では欠ける */
  unverifiedRepositories?: string[];
};

export type WorkflowTagsSnapshot = { overview: WorkflowTagsOverview; fetchedAt: number };

/**
 * 設定画面の開閉・複数の表示が同じ全件取得を重ねないための有効期限（#4016）。
 * 配布の操作や手動更新は`invalidateWorkflowTags`で捨てるので、外から変えたタグ公開やPRマージも
 * 再取得で追従できる。
 */
export const WORKFLOW_TAGS_TTL_MS = 60_000;

let cached: WorkflowTagsSnapshot | null = null;
let inflight: Promise<WorkflowTagsSnapshot> | null = null;
// 実行中の取得が今も最新の世代か（`invalidate`・後続のforce取得で入れ替わる）
let currentToken: object | null = null;

/** 期限内のキャッシュ。無ければ`null`（期限切れの値は現在確認済みの情報として渡さない） */
export function peekWorkflowTags(now = Date.now()): WorkflowTagsSnapshot | null {
  return cached && now - cached.fetchedAt < WORKFLOW_TAGS_TTL_MS ? cached : null;
}

/** キャッシュと実行中の取得を捨てる。配布開始・完了・手動の再取得の前に呼ぶ */
export function invalidateWorkflowTags(): void {
  cached = null;
  inflight = null;
  currentToken = null;
}

/**
 * 共有ワークフローの状況を取る。`force`でなければ期限内のキャッシュを返し、取得中の
 * リクエストがあれば相乗りする（同じ全件取得を重ねない）。
 */
export function loadWorkflowTags(force = false): Promise<WorkflowTagsSnapshot> {
  if (!force) {
    const hit = peekWorkflowTags();
    if (hit) return Promise.resolve(hit);
  }
  if (inflight) return inflight;

  const token = {};
  const request: Promise<WorkflowTagsSnapshot> = (async () => {
    // リポジトリごとにGitHub APIを叩くため、既定より長く待つ
    const res = await fetchWithTimeout("/api/workflow-tags", { timeoutMs: SLOW_FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
    const overview = (await res.json()) as WorkflowTagsOverview;
    const snapshot = { overview, fetchedAt: Date.now() };
    // 取得中に`invalidate`された場合は、古い結果をキャッシュへ戻さない
    if (currentToken === token) cached = snapshot;
    return snapshot;
  })().finally(() => {
    if (currentToken === token) inflight = null;
  });
  currentToken = token;
  inflight = request;
  return request;
}
