import { getAppJwt } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * GitHub Appのインストールそのものを読むAPI。
 *
 * **`repository_selection`はDBを見ずにGitHubへ聞く**（#2248）。DBの
 * `GithubInstallation.repositorySelection`は`installation`イベントでしか更新されず、
 * インストール画面で「All repositories」→「Only select repositories」へ切り替えたときに
 * 飛ぶ`installation_repositories`イベントでは更新されない。立ち上げの判断に使うと、
 * 選び方が戻されたことに気付かないまま手順を落とす。
 */

export type GithubInstallationResponse = {
  id: number;
  account: { id: number; login: string; type: string } | null;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
};

export async function fetchInstallation(
  installationId: number,
  jwt: string,
): Promise<GithubInstallationResponse> {
  const res = await githubFetch(`${GITHUB_API}/app/installations/${installationId}`, jwt);
  if (!res.ok) {
    throw new Error(`Failed to fetch installation: ${res.status}`);
  }
  return res.json();
}

/** インストール対象リポジトリの選び方を、App JWTで取り直す。 */
export async function fetchRepositorySelection(
  installationId: number,
): Promise<"all" | "selected"> {
  const jwt = await getAppJwt();
  const installation = await fetchInstallation(installationId, jwt);
  return installation.repository_selection;
}
