import { createAppAuth } from "@octokit/auth-app";

function getPrivateKey(): string {
  const base64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (!base64) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_BASE64 is not set");
  }
  return Buffer.from(base64, "base64").toString("utf-8");
}

function getAppId(): string {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) {
    throw new Error("GITHUB_APP_ID is not set");
  }
  return appId;
}

const auth = createAppAuth({
  appId: getAppId(),
  privateKey: getPrivateKey(),
});

export async function getAppJwt(): Promise<string> {
  const { token } = await auth({ type: "app" });
  return token;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const { token } = await auth({ type: "installation", installationId });
  return token;
}
