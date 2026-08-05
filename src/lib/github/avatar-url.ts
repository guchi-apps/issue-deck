/**
 * GitHubのユーザー名から、そのユーザーのプロフィールアイコンのURLを組み立てる。
 * `https://github.com/<login>.png` はGitHubが公式に提供している画像エンドポイントで、
 * ユーザーID等を別途取得・保存しなくてもloginだけからアイコン画像を取得できる。
 */
export function githubAvatarUrl(login: string): string {
  return `https://github.com/${login}.png?size=80`;
}
