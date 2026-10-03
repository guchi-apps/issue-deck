/** 本番デプロイ失敗時にmainへ選択的に取り込めるPR。 */
export type DeployRecoveryCandidate = {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  mergeCommitSha: string;
};

/** 選択入力を重複なく正のPR番号だけに正規化する。 */
export function normalizeDeployRecoverySelection(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const numbers = value.filter((number): number is number => Number.isSafeInteger(number) && number > 0);
  if (numbers.length !== value.length) return null;
  return [...new Set(numbers)];
}

/** main未反映のマージ済みPRだけを、取り込み順に返す。 */
export function selectDeployRecoveryCandidates(
  pullRequests: Array<DeployRecoveryCandidate>,
  developOnlyCommitShas: ReadonlySet<string>,
): DeployRecoveryCandidate[] {
  return pullRequests
    .filter((pullRequest) => developOnlyCommitShas.has(pullRequest.mergeCommitSha))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
}

/** 選択が現在も候補に含まれるかを確認し、候補側の安全な取り込み順に揃える。 */
export function resolveDeployRecoverySelection(
  candidates: DeployRecoveryCandidate[],
  selectedNumbers: number[],
): DeployRecoveryCandidate[] | null {
  const selected = new Set(selectedNumbers);
  const resolved = candidates.filter((candidate) => selected.has(candidate.number));
  return resolved.length === selected.size ? resolved : null;
}

export function deployRecoveryErrorMessage(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "invalid_request") return "取り込むPRを1件以上選択してください。";
  if (errorCode === "no_candidates") return "mainへ取り込めるマージ済みPRがありません。";
  if (errorCode === "candidate_changed") return "選択したPRの状態が変わりました。候補を読み直してください。";
  if (errorCode === "deploy_not_failed") return "本番デプロイが失敗中ではないため、復旧用PRは作成できません。";
  if (errorCode === "recovery_conflict") {
    return "選択したPRをmainへ取り込めませんでした。競合するPRを外すか、修正してからもう一度試してください。";
  }
  if (errorCode === "recovery_already_open" && message) return message;
  if (errorCode === "github_api_error" && message) return message;
  return `リクエストに失敗しました (${status})`;
}

export async function fetchDeployRecoveryCandidates(
  repositoryFullName: string,
): Promise<DeployRecoveryCandidate[]> {
  const [owner, repo] = repositoryFullName.split("/");
  const params = new URLSearchParams({ owner, repo });
  const response = await fetch(`/api/repositories/deploy-recovery?${params}`);
  const json: { candidates?: DeployRecoveryCandidate[]; error?: string; message?: string } = await response
    .json()
    .catch(() => ({}));
  if (!response.ok) throw new Error(deployRecoveryErrorMessage(response.status, json.error, json.message));
  return json.candidates ?? [];
}

export async function requestDeployRecovery(
  repositoryFullName: string,
  pullRequestNumbers: number[],
): Promise<{ url: string }> {
  const [owner, repo] = repositoryFullName.split("/");
  const response = await fetch("/api/repositories/deploy-recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, pullRequestNumbers }),
  });
  const json: { url?: string; error?: string; message?: string } = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(deployRecoveryErrorMessage(response.status, json.error, json.message));
  if (!json.url) throw new Error("復旧用PRのURLを取得できませんでした。");
  return { url: json.url };
}
