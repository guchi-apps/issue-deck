/**
 * GitHub APIの403・429の原因を分類する（#5366）。
 *
 * 403は原因によって応答本文とヘッダが違う。状態コードだけを残すと原因を切り分けられないため、
 * 本文の`message`とレート制限のヘッダから4分類へ振り分ける純関数にする。
 */
export type GithubForbiddenKind =
  | "installation_suspended"
  | "insufficient_permission"
  | "secondary_rate_limit"
  | "primary_rate_limit"
  | "unknown";

export type GithubForbiddenHeaders = {
  rateLimitRemaining?: string | null;
  rateLimitReset?: string | null;
  retryAfter?: string | null;
  requestId?: string | null;
};

export type GithubForbiddenCause = {
  kind: GithubForbiddenKind;
  /** 画面に添える短い原因（例: 「Appのインストールが停止中」） */
  label: string;
  /** 再取得できるまでの秒数（レート制限で分かるときだけ） */
  retryAfterSeconds: number | null;
};

/** 応答本文（JSONなら`message`、そうでなければ生の文字列）から`message`を取り出す */
export function extractGithubMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return (parsed as { message: string }).message;
    }
  } catch {
    // JSONでなければ生の文字列で判定する
  }
  return body;
}

function secondsOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

export function classifyGithubForbidden(
  body: string,
  headers: GithubForbiddenHeaders = {},
  nowMs: number = Date.now(),
): GithubForbiddenCause {
  const message = extractGithubMessage(body);
  const retryAfter = secondsOrNull(headers.retryAfter);

  if (/installation has been suspended/i.test(message)) {
    return { kind: "installation_suspended", label: "Appのインストールが停止中", retryAfterSeconds: null };
  }
  if (/secondary rate limit/i.test(message) || (retryAfter !== null && !/rate limit exceeded/i.test(message))) {
    return {
      kind: "secondary_rate_limit",
      label: retryAfter !== null ? `二次レート制限。${retryAfter}秒後に再取得できます` : "二次レート制限。しばらく待つと再取得できます",
      retryAfterSeconds: retryAfter,
    };
  }
  if (headers.rateLimitRemaining === "0" || /api rate limit exceeded/i.test(message)) {
    const reset = secondsOrNull(headers.rateLimitReset);
    const wait = reset === null ? null : Math.max(0, Math.ceil(reset - nowMs / 1000));
    return {
      kind: "primary_rate_limit",
      label: wait !== null ? `一次レート制限。${wait}秒後に再取得できます` : "一次レート制限。上限が回復すると再取得できます",
      retryAfterSeconds: wait,
    };
  }
  if (/resource not accessible by integration/i.test(message)) {
    return { kind: "insufficient_permission", label: "権限不足、または対象外のリポジトリ", retryAfterSeconds: null };
  }
  return { kind: "unknown", label: "原因を特定できませんでした", retryAfterSeconds: null };
}

/** 状態コードと原因を画面向けの括弧書きにする。403・429以外は原因を添えない */
export function describeGithubStatus(status: number, cause: GithubForbiddenCause | null): string {
  return cause && cause.kind !== "unknown" ? `GitHub APIが${status}を返しました（${cause.label}）` : `GitHub APIが${status}を返しました`;
}

/** `GithubApiError`相当（status＋本文入りのmessage）から画面向けの原因文を作る。ヘッダは無いので本文だけで判定する */
export function describeGithubError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (typeof status !== "number") return null;
  if (status !== 403 && status !== 429) return `GitHub APIが${status}を返しました`;
  return describeGithubStatus(status, classifyGithubForbidden(typeof message === "string" ? message : ""));
}
