/**
 * Slack起案連携の設定（#4454）。**値はサーバー側の環境変数だけに置く**（画面・ログ・Issue本文へ出さない）。
 *
 * - `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN`: どちらかが無ければ連携は無効（受け口は503）
 * - `SLACK_ALLOWED_TEAM_IDS` / `SLACK_ALLOWED_CHANNEL_IDS`: カンマ区切り。既定は初期対象のWorkspace・チャンネル
 * - `SLACK_USER_MAP`: `{"U0C8B85JHF0":"<IssueDeckのユーザーID>"}`。載っていないSlackユーザーは拒否する
 * - `SLACK_ALLOWED_REPO_OWNERS`: 候補にするGitHub Organization／ユーザー（カンマ区切り。未設定なら制限しない）
 */

const DEFAULT_TEAM_IDS = ["T0C8GTB3CP6"];
const DEFAULT_CHANNEL_IDS = ["C0C873R7JTV"];

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export type SlackConfig = {
  signingSecret: string;
  botToken: string;
  teamIds: string[];
  channelIds: string[];
  userMap: Record<string, string>;
  repoOwners: string[];
};

export function loadSlackConfig(env: Record<string, string | undefined> = process.env): SlackConfig | null {
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  if (!signingSecret || !botToken) return null;
  let userMap: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(env.SLACK_USER_MAP ?? "{}");
    if (parsed && typeof parsed === "object") {
      userMap = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    userMap = {};
  }
  return {
    signingSecret,
    botToken,
    teamIds: list(env.SLACK_ALLOWED_TEAM_IDS, DEFAULT_TEAM_IDS),
    channelIds: list(env.SLACK_ALLOWED_CHANNEL_IDS, DEFAULT_CHANNEL_IDS),
    userMap,
    repoOwners: list(env.SLACK_ALLOWED_REPO_OWNERS, []),
  };
}

export function isAllowedLocation(config: SlackConfig, teamId: string, channelId: string): boolean {
  return config.teamIds.includes(teamId) && config.channelIds.includes(channelId);
}

/** Slackユーザー→IssueDeckユーザー。載っていなければnull（拒否） */
export function resolveIssueDeckUser(config: SlackConfig, slackUserId: string): string | null {
  return config.userMap[slackUserId] ?? null;
}

export function isAllowedRepoOwner(config: SlackConfig, fullName: string): boolean {
  if (config.repoOwners.length === 0) return true;
  const owner = fullName.split("/")[0]?.toLowerCase();
  return config.repoOwners.some((allowed) => allowed.toLowerCase() === owner);
}
