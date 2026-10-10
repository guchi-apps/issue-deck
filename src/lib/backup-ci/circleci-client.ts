/**
 * CircleCI API v2の最小クライアント（#4065）。issue-deckから直接呼び、起動・結果回収を
 * GitHub Actionsに依存させない。
 *
 * **起動（POST）は再送しない。** 応答が返る前に失敗しても、CircleCI側ではパイプラインが
 * 作られていることがある。起動要求の失敗は`unknown`として返し、呼び出し側が「応答不明」として
 * 記録する（利用者が明示的に次の試行を始めるまで、勝手に投げ直さない）。
 */

export const CIRCLECI_API = "https://circleci.com/api/v2";
const TIMEOUT_MS = 15_000;

export type CircleciFetch = (url: string, init: RequestInit) => Promise<Response>;

export type TriggerPipelineInput = {
  projectSlug: string;
  definitionId: string;
  /**
   * 設定を読み、チェックアウトもするブランチ（信頼済み。PRのbase）。configとcheckoutが同じ
   * リポジトリのとき、CircleCIは両者のrefが一致しないと起動を拒否する（HTTP 400「Config ref must
   * match checkout ref」。#4215）ため、1つしか受け取らない。PRのheadはジョブの中で`head_sha`を
   * SHA指定で`git fetch`して取り出す
   */
  branch: string;
  parameters: Record<string, string | boolean>;
};

export type TriggerPipelineResult =
  | { kind: "created"; pipelineId: string; pipelineNumber: number | null }
  /** CircleCIが明示的に拒否した（4xx）。理由と必要な操作を画面に出す */
  | { kind: "rejected"; httpStatus: number; reason: string }
  /** 応答が分からない（タイムアウト・接続断・5xx）。**再送しない** */
  | { kind: "unknown"; reason: string };

export type CircleciWorkflow = { id: string; name: string; status: string };
export type CircleciJob = { jobNumber: number | null; name: string; status: string };
export type CircleciArtifact = { path: string; url: string };

export function createCircleciClient(token: string, fetcher: CircleciFetch = fetch) {
  const headers = { "Circle-Token": token, Accept: "application/json", "Content-Type": "application/json" };

  async function getJson(url: string): Promise<unknown> {
    const res = await fetcher(url, { headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new CircleciApiError(res.status, `${res.status} ${url}`);
    return res.json();
  }

  return {
    async triggerPipeline(input: TriggerPipelineInput): Promise<TriggerPipelineResult> {
      let res: Response;
      try {
        res = await fetcher(`${CIRCLECI_API}/project/${input.projectSlug}/pipeline/run`, {
          method: "POST",
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            definition_id: input.definitionId,
            config: { branch: input.branch },
            checkout: { branch: input.branch },
            parameters: input.parameters,
          }),
        });
      } catch (error) {
        return { kind: "unknown", reason: `CircleCIからの応答がありません（${errorMessage(error)}）` };
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status >= 500) {
        return { kind: "unknown", reason: `CircleCIがエラーを返しました（HTTP ${res.status}）` };
      }
      if (!res.ok) {
        return { kind: "rejected", httpStatus: res.status, reason: describeRejection(res.status, body) };
      }
      if (typeof body?.id !== "string") {
        return { kind: "unknown", reason: "CircleCIの応答にパイプラインIDがありません" };
      }
      return { kind: "created", pipelineId: body.id, pipelineNumber: typeof body.number === "number" ? body.number : null };
    },

    async getPipelineWorkflows(pipelineId: string): Promise<CircleciWorkflow[]> {
      const json = (await getJson(`${CIRCLECI_API}/pipeline/${pipelineId}/workflow`)) as { items?: unknown[] };
      return (json.items ?? []).flatMap((item) => {
        const w = item as Record<string, unknown>;
        return typeof w.id === "string" && typeof w.status === "string"
          ? [{ id: w.id, name: String(w.name ?? ""), status: w.status }]
          : [];
      });
    },

    async getWorkflowJobs(workflowId: string): Promise<CircleciJob[]> {
      const json = (await getJson(`${CIRCLECI_API}/workflow/${workflowId}/job`)) as { items?: unknown[] };
      return (json.items ?? []).flatMap((item) => {
        const j = item as Record<string, unknown>;
        return typeof j.status === "string"
          ? [{ jobNumber: typeof j.job_number === "number" ? j.job_number : null, name: String(j.name ?? ""), status: j.status }]
          : [];
      });
    },

    async getJobArtifacts(projectSlug: string, jobNumber: number): Promise<CircleciArtifact[]> {
      const json = (await getJson(`${CIRCLECI_API}/project/${projectSlug}/${jobNumber}/artifacts`)) as {
        items?: unknown[];
      };
      return (json.items ?? []).flatMap((item) => {
        const a = item as Record<string, unknown>;
        return typeof a.path === "string" && typeof a.url === "string" ? [{ path: a.path, url: a.url }] : [];
      });
    },

    /** 成果物（JSON）を読む。読めなければnull（呼び出し側が「結果を取得できない」として扱う） */
    async downloadJson(url: string): Promise<unknown> {
      try {
        const res = await fetcher(url, { headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
  };
}

export type CircleciClient = ReturnType<typeof createCircleciClient>;

export class CircleciApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CircleciApiError";
  }
}

/** CircleCIのWeb画面上のワークフローURL */
export function circleciWorkflowUrl(projectSlug: string, pipelineNumber: number | null, workflowId: string | null): string {
  const base = `https://app.circleci.com/pipelines/${projectSlug}`;
  if (pipelineNumber == null) return base;
  return workflowId ? `${base}/${pipelineNumber}/workflows/${workflowId}` : `${base}/${pipelineNumber}`;
}

/** 起動を拒否された理由を、利用者が次に何をすればよいかが分かる文へ写す */
export function describeRejection(status: number, body: Record<string, unknown> | null): string {
  const message = typeof body?.message === "string" ? body.message : "";
  if (status === 401) return "CircleCIのAPIトークンが無効です。CIRCLECI_API_TOKENを発行し直してください。";
  if (status === 403) return `CircleCIのAPIトークンにこのプロジェクトを起動する権限がありません。${message}`.trim();
  if (status === 404) return "CircleCIのプロジェクトまたはパイプライン定義が見つかりません。設定のプロジェクトスラッグと定義IDを確認してください。";
  if (status === 429) return "CircleCIのレート制限に達しました。しばらく待ってから再実行してください。";
  if (/credit|plan|quota|limit/i.test(message)) {
    return `CircleCIの無料枠（クレジット）が不足している可能性があります: ${message}`;
  }
  return `CircleCIが起動を拒否しました（HTTP ${status}）${message ? `: ${message}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
