export function getGithubAppInstallUrl(): string {
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  return `https://github.com/apps/${slug}/installations/new`;
}
