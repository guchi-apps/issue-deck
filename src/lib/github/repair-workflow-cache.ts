import {
  resolveRepairDispatch,
  type RepairKind,
  type RepairTargetPullRequest,
  type RepairWorkflowAvailability,
  type RepairWorkflowState,
} from "@/lib/github/pull-request-repair";
import {
  clearWorkflowExistsCacheForTest,
  workflowExists as workflowExistsCached,
} from "@/lib/github/workflow-exists-cache";
import { REPAIR_WORKFLOW_SPECS } from "@/lib/workflow-tags";

/**
 * **無い側は短く持つ。** 配布PR（#1948）がマージされた瞬間に偽から真へ変わる値で、
 * そこを10分持つと「配ったのにボタンが押せない」時間ができる。逆向き（真→偽）は起こらない。
 * 短いTTLで再確認するのはボタンが出ているPRがある間だけなので、消費は小さい
 * （`ISSUE_RUN_NEGATIVE_CACHE_TTL_MS`と同じ考え方）。
 *
 * キャッシュ本体とTTLの既定（有る側は10分）は`workflow-exists-cache.ts`が持つ（#2020）。
 */
const REPAIR_WORKFLOW_MISSING_TTL_MS = 60_000;

function workflowExists(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
): Promise<boolean> {
  return workflowExistsCached(owner, repo, workflowFile, token, {
    missingTtlMs: REPAIR_WORKFLOW_MISSING_TTL_MS,
  });
}

/**
 * 未配布のcallerを、これから配れるのか（`missing`）配布の対象ですらないのか（`unsupported`）に分ける。
 *
 * 配布の一覧は`missingRepairWorkflows`が作っており、`REPAIR_WORKFLOW_SPECS`の`requires`を
 * **すべて**持つリポジトリしか対象にしない（#1948）。例えば`release-develop-to-main.yml`はあるが
 * `claude-issue-dispatch.yml`が無いリポジトリでは、`issue-<番号>`のPRに出るCI修正ボタンの
 * 起動先（`claude-ci-fix.yml`）は配布の一覧に現れない。そこへ「設定＞フリート運用から配れます」と
 * 案内すると行き止まりになるため、前提ファイルの有無まで確かめて文言を分ける。
 *
 * **`requires`が複数になった**（#2303）。1つでも欠ければ配布の一覧に出ないので`unsupported`。
 * 順に確かめて**欠けが見つかった時点で打ち切る**（残りを問い合わせても結論は変わらず、
 * GitHub APIを無駄に消費するだけ）。並びは安い順ではなく宣言順で、`REPAIR_WORKFLOW_SOURCE`
 * （どのcallerにも要る参照元）が先頭に来るため、対象外のリポジトリでは1回で決まる。
 */
async function resolveMissingState(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
): Promise<RepairWorkflowState> {
  const requires = REPAIR_WORKFLOW_SPECS.find((spec) => spec.file === workflowFile)?.requires;
  if (!requires) return "missing";
  for (const required of requires) {
    if (!(await workflowExists(owner, repo, required, token))) return "unsupported";
  }
  return "missing";
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
  clearWorkflowExistsCacheForTest();
}
