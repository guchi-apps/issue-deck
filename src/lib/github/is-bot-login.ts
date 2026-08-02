export function isBotLogin(login: string): boolean {
  return login.endsWith("[bot]");
}
