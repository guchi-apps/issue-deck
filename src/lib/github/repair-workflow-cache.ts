import {
  resolveRepairDispatch,
  type RepairKind,
  type RepairTargetPullRequest,
  type RepairWorkflowAvailability,
  type RepairWorkflowState,
} from "@/lib/github/pull-request-repair";
import { fetchWorkflowExists } from "@/lib/github/release-api";
import { REPAIR_WORKFLOW_SPECS } from "@/lib/workflow-tags";

/**
 * 配られているワークフローが消えることはまず無いため、`releaseWorkflowExists`と同じ間隔で
 * プロセス内にキャッシュする。本番はPM2のfork（単一プロセス）で動作し、プロセスが
 * 入れ替わればキャッシュは空になる。
 */
const REPAIR_WORKFLOW_EXISTS_TTL_MS = 10 * 60_000;

/**
 * **無い側は短く持つ。** 配布PR（#1948）がマージされた瞬間に偽から真へ変わる値で、
 * そこを10分持つと「配ったのにボタンが押せない」時間ができる。逆向き（真→偽）は起こらない。
 * 短いTTLで再確認するのはボタンが出ているPRがある間だけなので、消費は小さい
 * （`ISSUE_RUN_NEGATIVE_CACHE_TTL_MS`と同じ考え方）。
 */
const REPAIR_WORKFLOW_MISSING_TTL_MS = 60_000;

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
  if (cached) {
    const ttl = cached.exists ? REPAIR_WORKFLOW_EXISTS_TTL_MS : REPAIR_WORKFLOW_MISSING_TTL_MS;
    if (Date.now() - cached.cachedAt < ttl) return cached.exists;
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
 * 未配布のcallerを、これから配れるのか（`missing`）配布の対象ですらないのか（`unsupported`）に分ける。
 *
 * 配布の一覧は`missingRepairWorkflows`が作っており、`REPAIR_WORKFLOW_SPECS`の`requires`を
 * 持つリポジトリしか対象にしない（#1948）。例えば`release-develop-to-main.yml`はあるが
 * `claude-issue-dispatch.yml`が無いリポジトリでは、`issue-<番号>`のPRに出るCI修正ボタンの
 * 起動先（`claude-ci-fix.yml`）は配布の一覧に現れない。そこへ「設定＞フリート運用から配れます」と
 * 案内すると行き止まりになるため、前提ファイルの有無まで確かめて文言を分ける。
 */
async function resolveMissingState(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
): Promise<RepairWorkflowState> {
  const requires = REPAIR_WORKFLOW_SPECS.find((spec) => spec.file === workflowFile)?.requires;
  if (!requires) return "missing";
  return (await workflowExists(owner, repo, requires, token)) ? "missing" : "unsupported";
}

/**
 * このPRに出す修復ボタンの種類ごとに、起動先ワークフローが対象リポジトリにあるか（#1960）。
 *
 * **ボタンを出す種類（`repairKindsFor`の結果）だけを渡すこと。** 出さない種類まで問い合わせると、
 * 画面に現れない判定のためにGitHub APIを消費する。前提ファイルの確認も、無いと分かった種類に
 * ついてしか行わない。
 *
 * 判定に失敗した種類はキーごと落とし、押せるままにする（`RepairWorkflowAvailability`）。
 * 存在確認が404以外で落ちるのは権限・障害といった一時的な理由で、そこでボタンを無効化すると
 * 「配ってあるのに押せない」状態になるため。**ここで握り潰すのは呼び出し側のためでもある**——
 * 一覧APIはリポジトリ単位のcatchでPRを丸ごと落とすので、投げ返すと「ボタンが無効になる」
 * ではなく「一覧からリポジトリが消える」退行になる。
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
        availability[kind] = (await workflowExists(owner, repo, workflowFile, token))
          ? "available"
          : await resolveMissingState(owner, repo, workflowFile, token);
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
