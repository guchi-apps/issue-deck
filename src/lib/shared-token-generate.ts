const GENERATED_TOKEN_BYTES = 32;

/** 共有トークン用のランダム値（32バイト）をURLセーフなbase64（パディング無し・43文字）で返す。 */
export function generateSharedTokenValue(): string {
  const bytes = new Uint8Array(GENERATED_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
