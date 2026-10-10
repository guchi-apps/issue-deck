import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * 引き継ぎ用の行（#3846）へ置くセッションのトークンの暗号化。
 *
 * 行は60秒だけ存在し、消費時に消す。それでもDBへ平文のトークンは置かない。
 * 新しいシークレットを足さないため、GitHubトークンの保存に使っている既存の鍵
 * （`GITHUB_USER_TOKEN_ENCRYPTION_KEY`）からHKDFで用途専用の鍵を導く（用途の印 `info` が
 * 違えば別の鍵になり、保存済みのGitHubトークンの暗号文とは鍵を共有しない）。
 * Push用の署名鍵（`VAPID_PRIVATE_KEY`）は、ローテーションの影響が混ざるため使わない。
 * 鍵が未設定ならログインの引き継ぎごと閉じる（平文へ落とさない）。
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const INFO = "issuedeck-native-auth-handoff-v1";

function getKey(): Buffer {
  const base64 = process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY;
  if (!base64) {
    throw new Error("GITHUB_USER_TOKEN_ENCRYPTION_KEY is not set");
  }
  const secret = Buffer.from(base64, "base64");
  if (secret.length !== 32) {
    throw new Error("GITHUB_USER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return Buffer.from(hkdfSync("sha256", secret, "", INFO, 32));
}

export function encryptSession(plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSession(cipherText: string): string {
  const [ivB64, authTagB64, encryptedB64] = cipherText.split(":");
  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error("Invalid cipher text format");
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final(),
  ]).toString("utf-8");
}
