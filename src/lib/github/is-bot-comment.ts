export function isBotComment(login: string): boolean {
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  return login === `${slug}[bot]`;
}
