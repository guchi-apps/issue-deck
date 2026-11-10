import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { createComment, createIssue, fetchOpenIssuesForRepo, fetchRepositoryLabelNames, updateIssue } from "@/lib/github/issues-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  buildDriftIssueBody,
  buildDriftIssueTitle,
  buildPublisherSet,
  detectRequiredCheckDrift,
  extractSignature,
  findingsSignature,
  REQUIRED_CHECKS_DRIFT_MARKER,
  type RequiredCheckFinding,
} from "@/lib/required-checks-drift";

/**
 * 必須チェックのずれ・発行元のない項目の巡回検知（#5313）。判定は`required-checks-drift.ts`。
 *
 * 対象はissue-deck自身のdevelop・main。発行元（`ci/required-checks.json`・ワークフロー）をこの
 * リポジトリの中から引けるのはここだけのため。取得はインストールトークンで、classic保護の
 * `protection`は読めなければ（権限不足）巡回を失敗として扱い、推測でずれと報告しない。
 * **検知と通知までで修正はしない。** 通知は`00.check-user`＋`01.check-blocked`付きのIssue。
 */
export const DRIFT_TARGET_REPOSITORY = "guchi-apps/issue-deck";
const BRANCHES = ["develop", "main"];
const DEFAULT_INTERVAL_MINUTES = 60;

let lastSweptAt: number | null = null;

export function resetRequiredChecksDriftSweepForTest(): void {
  lastSweptAt = null;
}

export type RequiredChecksDriftSweepResult = {
  swept: boolean;
  disabled: boolean;
  action: "created" | "updated" | "closed" | "none";
  issueNumber: number | null;
  findings: number;
};

function intervalMinutes(): number {
  const raw = process.env.REQUIRED_CHECKS_DRIFT_SWEEP_INTERVAL_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MINUTES;
}

async function getJson<T>(url: string, token: string): Promise<T | null> {
  const res = await githubFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${url}`);
  return (await res.json()) as T;
}

async function getFileText(owner: string, repo: string, path: string, ref: string, token: string): Promise<string | null> {
  const data = await getJson<{ content?: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  return data?.content ? Buffer.from(data.content, "base64").toString("utf8") : null;
}

export async function runRequiredChecksDriftSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<RequiredChecksDriftSweepResult> {
  const minutes = intervalMinutes();
  const none = { swept: false, disabled: false, action: "none", issueNumber: null, findings: 0 } as const;
  if (minutes === 0) return { ...none, disabled: true };
  const nowMs = (options.now ?? new Date()).getTime();
  if (!options.force && lastSweptAt !== null && nowMs - lastSweptAt < minutes * 60_000) return { ...none };
  lastSweptAt = nowMs;

  const repository = await db.repository.findFirst({
    where: { fullName: DRIFT_TARGET_REPOSITORY, archived: false },
    include: { installation: true },
  });
  if (!repository) return { ...none, swept: true };
  const [owner, repo] = [repository.ownerLogin, repository.name];
  const token = await getInstallationToken(repository.installation.installationId);

  // 発行元は、通常のブランチ（develop）の正本から集める
  const manifestText = await getFileText(owner, repo, "ci/required-checks.json", "develop", token);
  const manifestGroups = manifestText ? Object.keys(JSON.parse(manifestText).groups ?? {}) : [];
  const files = (await getJson<{ name: string; path: string }[]>(`${GITHUB_API}/repos/${owner}/${repo}/contents/.github/workflows?ref=develop`, token)) ?? [];
  const workflowYamls: string[] = [];
  for (const f of files.filter((f) => /\.ya?ml$/.test(f.name))) {
    const text = await getFileText(owner, repo, f.path, "develop", token);
    if (text) workflowYamls.push(text);
  }
  // 発行元が1つも取れない（取得失敗）ときは、全項目を「発行元なし」と誤報しないよう止める
  if (manifestGroups.length === 0 || workflowYamls.length === 0) {
    throw new Error("発行元（ci/required-checks.json・ワークフロー）を取得できませんでした");
  }
  const publishers = buildPublisherSet({ manifestGroups, workflowYamls });

  const byBranch: { branch: string; findings: RequiredCheckFinding[] }[] = [];
  for (const branch of BRANCHES) {
    const b = encodeURIComponent(branch);
    const [rules, protectionBranch] = await Promise.all([
      getJson<{ type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[]>(
        `${GITHUB_API}/repos/${owner}/${repo}/rules/branches/${b}`,
        token,
      ),
      getJson<{ protection?: { required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } | null } | null }>(
        `${GITHUB_API}/repos/${owner}/${repo}/branches/${b}`,
        token,
      ),
    ]);
    if (protectionBranch === null) continue; // ブランチ自体が無い
    const ruleset = (rules ?? [])
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context ?? ""))
      .filter(Boolean);
    const rsc = protectionBranch.protection?.required_status_checks;
    const classic = [...new Set([...(rsc?.contexts ?? []), ...(rsc?.checks ?? []).map((c) => c.context ?? "")])].filter(Boolean);
    const findings = detectRequiredCheckDrift({ ruleset, classic }, publishers);
    if (findings.length > 0) byBranch.push({ branch, findings });
  }

  const total = byBranch.reduce((n, b) => n + b.findings.length, 0);
  const open = (await fetchOpenIssuesForRepo(owner, repo, token)).find((i) => i.body?.includes(REQUIRED_CHECKS_DRIFT_MARKER));

  if (total === 0) {
    if (!open) return { swept: true, disabled: false, action: "none", issueNumber: null, findings: 0 };
    await createComment(owner, repo, open.number, token, {
      body: "必須チェックのずれが解消されたことを確認したため、このIssueをクローズします。\n\n<!-- issue-deck-agent:implementer -->",
    });
    await updateIssue(owner, repo, open.number, token, { state: "closed", state_reason: "completed" });
    return { swept: true, disabled: false, action: "closed", issueNumber: open.number, findings: 0 };
  }

  const signature = byBranch.map((b) => findingsSignature(b.branch, b.findings)).join("|");
  if (open) {
    // 同じずれなら何もしない（巡回のたびにコメントを積まない）
    if (extractSignature(open.body) === signature) {
      return { swept: true, disabled: false, action: "none", issueNumber: open.number, findings: total };
    }
    await updateIssue(owner, repo, open.number, token, {
      body: buildDriftIssueBody({ repositoryFullName: repository.fullName, byBranch, signature }),
    });
    await createComment(owner, repo, open.number, token, {
      body: "ずれの内容が変わったため、本文を更新しました。\n\n<!-- issue-deck-agent:implementer -->",
    });
    return { swept: true, disabled: false, action: "updated", issueNumber: open.number, findings: total };
  }

  const existing = await fetchRepositoryLabelNames(owner, repo, token).catch(() => new Set<string>());
  const created = await createIssue(owner, repo, token, {
    title: buildDriftIssueTitle(repository.fullName),
    body: buildDriftIssueBody({ repositoryFullName: repository.fullName, byBranch, signature }),
    labels: ["00.check-user", "01.check-blocked"].filter((l) => existing.has(l)),
  });
  return { swept: true, disabled: false, action: "created", issueNumber: created.number, findings: total };
}
