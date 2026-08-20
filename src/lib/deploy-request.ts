/**
 * 本番デプロイworkflow（`deploy.yml`）の起動リクエスト（#2020）。
 *
 * 起動の導線は「ブランチ」画面の「本番へ再デプロイ」だけだが、叩くエンドポイントと
 * エラーの読み方を`lib/release-request.ts`と同じ形で1か所に置いておく。**この画面は
 * 「追加のGitHub API取得をしない」前提で作られている**（`lib/branch-flow.ts`）ので、
 * 起動の可否も進み具合も問い合わせず、この関数はdispatchだけを行う。
 */

/** エラーコードを画面に出す文言へ直す */
export function deployErrorMessage(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_reauth_required") {
    return "GitHub連携が必要です。再ログインしてください。";
  }
  // 本番デプロイworkflowを持たないリポジトリ。必要なファイル名まで含めて言い切る。
  if (errorCode === "deploy_workflow_missing") {
    return "このリポジトリには本番デプロイworkflow（deploy.yml）がありません。";
  }
  // `deploy.yml`はあるが`workflow_dispatch`を書いていないリポジトリ。**押し直しても直らない**ので、
  // 何を足せば押せるようになるかまで書く。
  if (errorCode === "deploy_dispatch_unsupported") {
    return "このリポジトリのdeploy.ymlは手動起動に未対応です。deploy.ymlにworkflow_dispatchを足すと押せるようになります。";
  }
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

/**
 * `POST /api/repositories/deploy`。成功すれば何も返さず、失敗すれば
 * {@link deployErrorMessage} の文言を持つ`Error`を投げる。
 */
export async function requestDeploy(repoFullName: string): Promise<void> {
  const [owner, repo] = repoFullName.split("/");

  const res = await fetch("/api/repositories/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo }),
  });
  const json: { error?: string; message?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(deployErrorMessage(res.status, json.error, json.message));
}
