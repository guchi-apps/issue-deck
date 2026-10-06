/**
 * 調査結果・保存ログから機密値を落とす（#4045）。
 *
 * 取得したコメント・ログ・コードの本文は、そのままモデルへ渡して画面にも出る。トークンの形をした
 * 文字列が混ざっていても露出させないため、**取得した直後にここを通す**。パターンは広めに取り、
 * 誤って伏せる側へ倒す（調査の材料としては値そのものが要らない）。
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
];

const ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*(["']?)[^\s"']{6,}\2/gi;

export function redactSecrets(text: string): string {
  let out = text.replace(ASSIGNMENT_PATTERN, "$1=[伏せ字]");
  for (const pattern of SECRET_PATTERNS) {
    // グループを持たないパターンでは第2引数がマッチ位置（数値）になるため、文字列のときだけ使う
    out = out.replace(pattern, (_match, head: unknown, tail: unknown) =>
      typeof head === "string" && typeof tail === "string"
        ? `${head}\n[伏せ字]\n${tail}`
        : typeof head === "string"
          ? `${head}[伏せ字]`
          : "[伏せ字]",
    );
  }
  return out;
}

/** 長い本文を、先頭と末尾を残して切る（ログは末尾に原因が出ることが多い） */
export function clip(text: string, max: number, keep: "head" | "tail" = "head"): string {
  if (text.length <= max) return text;
  return keep === "head"
    ? `${text.slice(0, max)}\n…（${text.length - max}文字省略）`
    : `…（${text.length - max}文字省略）\n${text.slice(text.length - max)}`;
}
