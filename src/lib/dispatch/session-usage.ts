import { db } from "@/lib/db";

/**
 * サブPCのローカルセッションが使ったトークンの報告を受ける側（#2504）。
 *
 * **報告は「全件置換」ではなく「送られてきた行の上書き」。** `DispatchSession`の報告
 * （`sessions.ts`）は含まれない行を「消えた」とみなすが、こちらは過去ぶんを溜めていく表なので
 * 同じ扱いにはできない。pollerは直近数日ぶんの転記しか開かず、その外の行は送られてこない。
 *
 * **1行＝転記1本で、走っている間は何度でも上書きされる。** セッションは終わるまで追記され
 * 続けるため、pollerは同じ転記を5分おきに送る。`(host, sessionId)`で一意にして毎回まるごと
 * 置き換えることで、「途中まで」の行が二重に積まれない。
 *
 * **受け取るのは数値と分類だけで、やり取りの本文は入ってこない。** 集計する
 * `scripts/lib/session-usage.sh`が`message.usage`と時刻・作業ディレクトリしか読んでいない。
 */

/** 1回の報告で受け取るセッションの上限。pollerは200件ずつに割って送ってくる */
const MAX_SESSIONS_PER_REPORT = 500;

/**
 * 保持する日数。**過ぎた行は報告のたびに落とす。**
 * 1日あたり40〜60行増えるので、180日で1万行前後に落ち着く。
 */
export const SESSION_USAGE_RETENTION_DAYS = 180;

/** 種別。`scripts/lib/session-usage.sh`の`classify()`と対応する */
export const SESSION_USAGE_KINDS = ["implementation", "plan-review", "question", "other"] as const;
export type SessionUsageKind = (typeof SESSION_USAGE_KINDS)[number];
export const SESSION_USAGE_AGENTS = ["claude", "codex"] as const;
export type SessionUsageAgent = (typeof SESSION_USAGE_AGENTS)[number];

export type SessionUsageReport = {
  agent: SessionUsageAgent;
  sessionId: string;
  transcript: string;
  kind: SessionUsageKind;
  repository: string | null;
  issueNumber: number | null;
  responses: number;
  inputTokens: number;
  cacheCreate5mTokens: number;
  cacheCreate1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * `costUsd`の入力側・出力側の内訳（#2626）。**片方でも欠けたら両方nullにする。**
   * 内訳を出さない報告元（この列より前のpoller）から届くことがあり、片側だけ入れると
   * 画面が「内訳の合計＝料金」を前提にできなくなる。
   */
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  /**
   * `costUsd`の計画（Plan mode）・実装の内訳（#2646）。**片方でも欠けたら両方nullにする**
   * （上のinputCostUsd/outputCostUsdと同じ理由）。Plan modeを使っていないセッション・
   * Codexの行は常にnull
   */
  planCostUsd: number | null;
  implementationCostUsd: number | null;
  /**
   * `implementationCostUsd`をさらに割った内訳（#2779）。調査＝最初のファイル編集まで、
   * 実装＝最初の`git commit`まで、仕上げ＝それ以降。**3つ揃っていなければ3つともnull**
   * （上のplanCostUsd/implementationCostUsdと同じ理由）
   */
  researchCostUsd: number | null;
  codingCostUsd: number | null;
  wrapupCostUsd: number | null;
  models: string[];
  startedAt: Date;
  endedAt: Date;
};

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** 金額（USD）。数値でない・負・非有限はnull（＝内訳なしとして扱う） */
function parseNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 191文字を超える値はカラムに入らないため、そこで切る（拒否はしない） */
function truncate(value: string, max = 191): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 報告1件を検証する。**壊れていたらnullを返し、呼び出し側がその1件だけを捨てる。**
 *
 * `DispatchSession`の報告と違って全件を拒否しない。あちらは1件落とすと「消えた」と判定されて
 * しまうが、こちらは落としても「その転記のぶんが載らない」だけで、次の報告で入り直す。
 * 転記の形はClaude Codeの内部仕様なので、1つの想定外で全体が止まる方が損になる。
 */
export function parseSessionUsageReport(value: unknown): SessionUsageReport | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;

  const agent = input.agent ?? "claude";
  if (typeof agent !== "string" || !SESSION_USAGE_AGENTS.includes(agent as SessionUsageAgent)) {
    return null;
  }

  const sessionId = input.sessionId;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 191) return null;

  const transcript = input.transcript;
  if (typeof transcript !== "string" || !transcript) return null;

  const kind = input.kind;
  if (typeof kind !== "string" || !SESSION_USAGE_KINDS.includes(kind as SessionUsageKind)) {
    return null;
  }

  const rawRepository = input.repository;
  let repository: string | null = null;
  if (rawRepository !== null && rawRepository !== undefined) {
    if (typeof rawRepository !== "string" || !rawRepository) return null;
    repository = truncate(rawRepository);
  }

  const rawIssue = input.issue;
  let issueNumber: number | null = null;
  if (rawIssue !== null && rawIssue !== undefined) {
    if (typeof rawIssue !== "number" || !Number.isSafeInteger(rawIssue) || rawIssue <= 0) return null;
    issueNumber = rawIssue;
  }

  const responses = parseNonNegativeInteger(input.responses);
  const inputTokens = parseNonNegativeInteger(input.input);
  const cacheCreate5mTokens = parseNonNegativeInteger(input.cacheCreate5m);
  const cacheCreate1hTokens = parseNonNegativeInteger(input.cacheCreate1h);
  const cacheReadTokens = parseNonNegativeInteger(input.cacheRead);
  const outputTokens = parseNonNegativeInteger(input.output);
  if (
    responses === null ||
    inputTokens === null ||
    cacheCreate5mTokens === null ||
    cacheCreate1hTokens === null ||
    cacheReadTokens === null ||
    outputTokens === null
  ) {
    return null;
  }
  // 応答が1つも無い転記は送られてこない想定だが、来ても意味が無いので落とす。
  if (responses === 0) return null;

  const costUsd = input.costUsd;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return null;

  // 内訳は無くても行そのものは受ける（古いpollerからの報告を落とさない）。
  const parsedInputCostUsd = parseNonNegativeNumber(input.inputCostUsd);
  const parsedOutputCostUsd = parseNonNegativeNumber(input.outputCostUsd);
  const hasCostSplit = parsedInputCostUsd !== null && parsedOutputCostUsd !== null;
  const inputCostUsd = hasCostSplit ? parsedInputCostUsd : null;
  const outputCostUsd = hasCostSplit ? parsedOutputCostUsd : null;

  // 計画/実装の内訳（#2646）。Plan modeを使っていないセッションは両方nullで届く。
  const parsedPlanCostUsd = parseNonNegativeNumber(input.planCostUsd);
  const parsedImplementationCostUsd = parseNonNegativeNumber(input.implementationCostUsd);
  const hasPlanSplit = parsedPlanCostUsd !== null && parsedImplementationCostUsd !== null;
  const planCostUsd = hasPlanSplit ? parsedPlanCostUsd : null;
  const implementationCostUsd = hasPlanSplit ? parsedImplementationCostUsd : null;

  // 実装の中の4区分（#2779）。**3つ揃っていなければ3つともnull**——欠けたまま入れると
  // 画面が「調査＋実装＋仕上げ＝実装の合計」を前提にできなくなる。
  const parsedResearchCostUsd = parseNonNegativeNumber(input.researchCostUsd);
  const parsedCodingCostUsd = parseNonNegativeNumber(input.codingCostUsd);
  const parsedWrapupCostUsd = parseNonNegativeNumber(input.wrapupCostUsd);
  const hasPhaseSplit =
    parsedResearchCostUsd !== null && parsedCodingCostUsd !== null && parsedWrapupCostUsd !== null;
  const researchCostUsd = hasPhaseSplit ? parsedResearchCostUsd : null;
  const codingCostUsd = hasPhaseSplit ? parsedCodingCostUsd : null;
  const wrapupCostUsd = hasPhaseSplit ? parsedWrapupCostUsd : null;

  const rawModels = input.models;
  if (!Array.isArray(rawModels) || rawModels.some((model) => typeof model !== "string")) return null;

  const startedAt = parseTimestamp(input.startedAt);
  const endedAt = parseTimestamp(input.endedAt);
  if (!startedAt || !endedAt) return null;

  return {
    agent: agent as SessionUsageAgent,
    sessionId,
    transcript,
    kind: kind as SessionUsageKind,
    repository,
    issueNumber,
    responses,
    inputTokens,
    cacheCreate5mTokens,
    cacheCreate1hTokens,
    cacheReadTokens,
    outputTokens,
    costUsd,
    inputCostUsd,
    outputCostUsd,
    planCostUsd,
    implementationCostUsd,
    researchCostUsd,
    codingCostUsd,
    wrapupCostUsd,
    models: rawModels as string[],
    startedAt,
    endedAt,
  };
}

/**
 * 報告の本文を丸ごと検証する。**壊れた行は捨て、読めた行だけを返す。**
 * `sessions`が配列でない・件数が多すぎる場合だけ、報告そのものを拒否する（nullを返す）。
 */
export function parseSessionUsagePayload(
  value: unknown,
): { reportedAt: Date; sessions: SessionUsageReport[]; skipped: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.sessions)) return null;
  if (input.sessions.length > MAX_SESSIONS_PER_REPORT) return null;

  // 送ってこないpollerもあり得るので、無ければ受け取った時刻で埋める。
  const reportedAt = parseTimestamp(input.reportedAt) ?? new Date();

  const sessions: SessionUsageReport[] = [];
  let skipped = 0;
  for (const item of input.sessions) {
    const parsed = parseSessionUsageReport(item);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    sessions.push(parsed);
  }

  return { reportedAt, sessions, skipped };
}

/**
 * 受け取った行を保存し、保持期間を過ぎた行を落とす。
 *
 * **upsertを1件ずつ回す。** MySQLの`INSERT ... ON DUPLICATE KEY UPDATE`をまとめて撃つ方が
 * 速いが、生SQLで列を並べ直す形になり、スキーマを変えたときに黙ってずれる。1回の報告は
 * 平常時20〜50件・埋め戻しでも200件で、まとめる価値のある量ではない。
 */
export async function storeSessionUsage({
  hostName,
  reportedAt,
  sessions,
}: {
  hostName: string;
  reportedAt: Date;
  sessions: SessionUsageReport[];
}): Promise<{ stored: number; deleted: number }> {
  for (const session of sessions) {
    const data = {
      transcript: session.transcript,
      kind: session.kind,
      repository: session.repository,
      issueNumber: session.issueNumber,
      responses: session.responses,
      inputTokens: BigInt(session.inputTokens),
      cacheCreate5mTokens: BigInt(session.cacheCreate5mTokens),
      cacheCreate1hTokens: BigInt(session.cacheCreate1hTokens),
      cacheReadTokens: BigInt(session.cacheReadTokens),
      outputTokens: BigInt(session.outputTokens),
      costUsd: session.costUsd,
      inputCostUsd: session.inputCostUsd,
      outputCostUsd: session.outputCostUsd,
      planCostUsd: session.planCostUsd,
      implementationCostUsd: session.implementationCostUsd,
      researchCostUsd: session.researchCostUsd,
      codingCostUsd: session.codingCostUsd,
      wrapupCostUsd: session.wrapupCostUsd,
      models: JSON.stringify(session.models),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      reportedAt,
    };
    await db.sessionUsage.upsert({
      where: {
        host_agent_sessionId: {
          host: hostName,
          agent: session.agent,
          sessionId: session.sessionId,
        },
      },
      create: { host: hostName, agent: session.agent, sessionId: session.sessionId, ...data },
      update: data,
    });
  }

  const cutoff = new Date(Date.now() - SESSION_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.sessionUsage.deleteMany({ where: { endedAt: { lt: cutoff } } });

  return { stored: sessions.length, deleted: deleted.count };
}
