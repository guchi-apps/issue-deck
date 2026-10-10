import {
  BACKUP_CI_DEFINITION_PATH,
  BACKUP_CI_ROLLOUT_FILES,
  type RolloutAssessment,
  type RolloutInput,
  assessRollout,
  buildMigrationCommands,
  definitionGroupNames,
  extractCiWorkflowJobs,
} from "@/lib/backup-ci/rollout";
import { getBackupCiReadiness } from "@/lib/backup-ci/service";
import { BackupCiError, installationTokenFor } from "@/lib/backup-ci/github";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * バックアップCIの他リポジトリへの展開（#4308）の状態確認と配布の起動。設計は docs/backup-ci.md「他リポジトリへの展開」。
 *
 * **全リポジトリを一律に有効化しない。** 画面で選んだ1リポジトリずつ調べ、配布PRも1件ずつ作る
 * （リポジトリ数ぶんのGitHub API呼び出しを一覧表示のたびに走らせない）。
 */

const SOURCE_REPOSITORY = "guchi-apps/issue-deck";
export const PROPAGATE_BACKUP_CI_WORKFLOW_FILE = "propagate-backup-ci.yml";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

async function fetchText(repo: string, path: string, ref: string, token: string): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url}`);
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.encoding !== "base64" || typeof json.content !== "string") return null;
  return Buffer.from(json.content, "base64").toString("utf8");
}

export type RolloutRepository = { fullName: string; defaultBranch: string | null; configured: boolean; enabled: boolean };

/** 展開先に選べるリポジトリ（アーカイブ済み・配布元自身を除く）。GitHubは呼ばず、DBの設定だけ見る */
export async function listRolloutRepositories(userId: string): Promise<RolloutRepository[]> {
  const repositories = await db.repository.findMany({
    where: { archived: false, installation: { userInstallations: { some: { userId } } }, NOT: { fullName: SOURCE_REPOSITORY } },
    select: { fullName: true, defaultBranch: true },
    orderBy: { fullName: "asc" },
  });
  const settings = await db.backupCiSetting.findMany({ where: { repositoryFullName: { in: repositories.map((r) => r.fullName) } } });
  const byName = new Map(settings.map((s) => [s.repositoryFullName, s]));
  return repositories.map((r) => {
    const setting = byName.get(r.fullName);
    return {
      fullName: r.fullName,
      defaultBranch: r.defaultBranch,
      configured: Boolean(setting?.circleciProjectSlug && setting.circleciDefinitionId),
      enabled: Boolean(setting?.enabled),
    };
  });
}

export type RolloutDetail = RolloutAssessment & {
  repositoryFullName: string;
  ref: string;
  /** 対象のdevelopの必須チェック（取得できなければnull。Administration権限が無いと読めない） */
  requiredChecks: string[] | null;
  /** 通常CIの必須ジョブ（定義のグループ）。移行コマンドで置き換える対象 */
  replaceContexts: string[];
  migration: ReturnType<typeof buildMigrationCommands>;
};

/** 1リポジトリの導入状態を調べる。取得できないものは「無い」ではなく確認不能として扱う（設定不足） */
export async function inspectRollout(userId: string, repositoryFullName: string): Promise<RolloutDetail> {
  const visible = await db.repository.findFirst({
    where: { fullName: repositoryFullName, archived: false, installation: { userInstallations: { some: { userId } } } },
    select: { fullName: true, defaultBranch: true },
  });
  if (!visible || repositoryFullName === SOURCE_REPOSITORY) throw new BackupCiError("not_found", "リポジトリが見つかりません。");

  const token = await installationTokenFor(repositoryFullName);
  const sourceToken = await installationTokenFor(SOURCE_REPOSITORY);
  const ref = (await branchExists(repositoryFullName, "develop", token)) ? "develop" : (visible.defaultBranch ?? "main");

  const files: RolloutInput["files"] = {};
  for (const path of BACKUP_CI_ROLLOUT_FILES) {
    const [target, source] = await Promise.all([
      fetchText(repositoryFullName, path, ref, token),
      fetchText(SOURCE_REPOSITORY, path, "main", sourceToken),
    ]);
    files[path] = target === null ? null : { matchesSource: source !== null && target === source };
  }
  const [definitionRaw, ciYaml, lockfile, packageJson] = await Promise.all([
    fetchText(repositoryFullName, BACKUP_CI_DEFINITION_PATH, ref, token),
    fetchText(repositoryFullName, CI_WORKFLOW_PATH, ref, token),
    fetchText(repositoryFullName, "pnpm-lock.yaml", ref, token),
    fetchText(repositoryFullName, "package.json", ref, token),
  ]);

  const readiness = await getBackupCiReadiness(repositoryFullName);
  const [passed, published] = await Promise.all([
    db.backupCiRun.count({ where: { repositoryFullName, status: "passed" } }),
    db.ciGateState.count({
      where: { repositoryFullName, publishedState: { not: null }, NOT: { publishedState: { startsWith: "publish_failed" } } },
    }),
  ]);

  const assessment = assessRollout({
    files,
    ciJobs: ciYaml === null ? null : extractCiWorkflowJobs(ciYaml),
    definitionRaw,
    // 定義の再生成はPR作成時（python）に行う。ここでは比べられないので、ジョブ名との対応で見る
    definitionMatchesGenerated: null,
    packageManager: packageJson === null ? "unknown" : lockfile !== null ? "pnpm" : "other",
    setting: readiness.setting,
    tokenConfigured: readiness.tokenConfigured,
    hasPassedRun: passed > 0,
    hasPublishedGate: published > 0,
  });

  const groups = definitionRaw ? (definitionGroupNames(definitionRaw) ?? []) : [];
  return {
    ...assessment,
    repositoryFullName,
    ref,
    requiredChecks: await fetchRequiredChecks(repositoryFullName, token),
    replaceContexts: groups,
    migration: buildMigrationCommands(repositoryFullName, groups),
  };
}

async function branchExists(repo: string, branch: string, token: string): Promise<boolean> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}/branches/${branch}`, token);
  return res.ok;
}

async function fetchRequiredChecks(repo: string, token: string): Promise<string[] | null> {
  try {
    const res = await githubFetch(`${GITHUB_API}/repos/${repo}/rules/branches/develop`, token);
    if (!res.ok) return null;
    const rules = (await res.json()) as { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
    return rules.filter((r) => r.type === "required_status_checks").flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));
  } catch {
    return null;
  }
}

export type DispatchBackupCiRolloutResult = { dispatched: true } | { dispatched: false; reason: "not_found" | "running"; message: string };

/** 配布PRを作るワークフローを起動する。対象は画面で選んだ1件だけ。実行中なら断る */
export async function dispatchBackupCiRollout(userId: string, repositoryFullName: string): Promise<DispatchBackupCiRolloutResult> {
  const visible = await db.repository.findFirst({
    where: { fullName: repositoryFullName, archived: false, installation: { userInstallations: { some: { userId } } } },
    select: { fullName: true },
  });
  if (!visible || repositoryFullName === SOURCE_REPOSITORY) {
    return { dispatched: false, reason: "not_found", message: "リポジトリが見つかりません。" };
  }
  const source = await db.repository.findFirst({ where: { fullName: SOURCE_REPOSITORY }, select: { installation: { select: { installationId: true } } } });
  if (!source) throw new Error(`${SOURCE_REPOSITORY} が同期されていません`);
  const token = await getInstallationToken(source.installation.installationId);
  const base = `${GITHUB_API}/repos/${SOURCE_REPOSITORY}/actions/workflows/${PROPAGATE_BACKUP_CI_WORKFLOW_FILE}`;

  // 同じ対象への配布が実行中なら起動しない（二重のPR作成・ブランチの取り合いを避ける）
  const runsRes = await githubFetch(`${base}/runs?per_page=20`, token);
  if (runsRes.ok) {
    const runs = ((await runsRes.json()) as { workflow_runs?: { status: string; display_title?: string }[] }).workflow_runs ?? [];
    if (runs.some((run) => run.status !== "completed")) {
      return { dispatched: false, reason: "running", message: "バックアップCIの配布が実行中です。完了してからもう一度押してください。" };
    }
  }
  const url = `${base}/dispatches`;
  const res = await githubFetch(url, token, { method: "POST", body: { ref: "main", inputs: { repository: repositoryFullName } } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return { dispatched: true };
}
