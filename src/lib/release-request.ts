/**
 * リリースworkflowの起動リクエスト（#1510）。
 *
 * 起動の導線は2か所ある——PCの「ブランチ」画面の「リリースする」
 * （`repository-release-button.tsx`）と、スマホのリリースシート（`mobile-release-sheet.tsx`）。
 * PCヘッダーのロケットボタンは#1614で通知ベルへ置き換えたため、起動の導線ではなくなった。
 * **叩くエンドポイントもエラーの読み方も1か所に置く**ことで、どちらから押しても同じ結果に
 * なることを保つ。流れ画面のボタンは状態取得（`useReleaseStatus`）を必要としないため、
 * ポーリングを持つフックごと持ち込まずにこの関数だけを使う。
 */

import type { BumpKind } from "@/lib/semver-bump";

/** エラーコードを画面に出す文言へ直す。`useReleaseStatus`の取得側と同じ文面に揃えている */
export function releaseErrorMessage(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_reauth_required") {
    return "GitHub連携が必要です。再ログインしてください。";
  }
  // リリース用workflowを持たないリポジトリ（#1538）。GitHubの生の404本文を出しても
  // 何が足りないのか読み取れないため、必要なファイル名まで含めて言い切る。
  if (errorCode === "release_workflow_missing") {
    return "このリポジトリにはリリース用workflow（release-develop-to-main.yml）がありません。";
  }
  // 上げ幅の指定（`bump_kind`）を受け取れない世代のworkflowを持つリポジトリ（#1548）。
  // GitHubは`Unexpected inputs provided`の422で落とすが、そのままでは何をすればよいか読めない。
  if (errorCode === "bump_kind_unsupported") {
    return "このリポジトリのリリースworkflowは上げ幅の指定に未対応です。自動判定で起動してください。";
  }
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

/**
 * `POST /api/repositories/release`。成功すれば何も返さず、失敗すれば
 * {@link releaseErrorMessage} の文言を持つ`Error`を投げる。
 *
 * `bumpKind`を渡すとバージョンの上げ幅をworkflowへ指定する（#1548）。**渡さない場合は
 * 従来どおりinput無しでdispatchし、workflow内のClaudeがコード差分から判定する。**
 */
export async function requestRelease(repoFullName: string, bumpKind?: BumpKind): Promise<void> {
  const [owner, repo] = repoFullName.split("/");

  const res = await fetch("/api/repositories/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, ...(bumpKind ? { bumpKind } : {}) }),
  });
  const json: { error?: string; message?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(releaseErrorMessage(res.status, json.error, json.message));
}
