import { callClaudeMessages } from "@/lib/claude/request";

/**
 * デプロイ失敗の帯の「原因をAIに聞く」（#3887）。失敗したジョブのログ末尾を読ませ、
 * 原因の推定と、再デプロイで直る見込みかを返す。
 *
 * **返すのは提案まで。** 修正Issueを立てるかどうかは、画面で読んだ人が決める
 * （他のIssue下書き生成と同じ立場）。
 */

/** プロンプトへ載せるログの長さ。**末尾を残して切る**（失敗は最後に出るため） */
export const DEPLOY_FAILURE_LOG_MAX_LENGTH = 6000;

/** 画面へ出すログ抜粋の行数の上限 */
const EXCERPT_MAX_LINES = 12;

const CAUSE_MAX_LENGTH = 600;
const EXCERPT_MAX_LENGTH = 1500;

export type DeployFailureAnalysis = {
  /** 何が起きたか（1〜3文） */
  cause: string;
  /** 一時的な失敗で、流し直せば直る見込みか */
  retryMayFix: boolean;
  /** 原因を示すログの抜粋（原文）。無ければ空文字 */
  excerpt: string;
  /** 直し方の提案（1〜2文）。無ければnull */
  advice: string | null;
};

/**
 * ログの行頭のタイムスタンプ・ANSIの色指定を落とし、**秘密値になりうる文字列を伏せる**。
 * ログはAIへ送られ、結果は修正Issue（公開リポジトリのこともある）の本文に入るため、
 * 既知のトークン形式と`KEY=value`形式の値を送る前に潰しておく。
 */
export function sanitizeDeployLog(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***")
    .replace(/\bop:\/\/[^\s'"]+/g, "op://***")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*)(\s*[=:]\s*)\S+/g,
      "$1$2***",
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***:***@");
}

/** 整形したうえで末尾を残して切る */
export function tailDeployLog(raw: string, maxLength = DEPLOY_FAILURE_LOG_MAX_LENGTH): string {
  const clean = sanitizeDeployLog(raw).trimEnd();
  if (clean.length <= maxLength) return clean;
  return `...(先頭を省略)\n${clean.slice(-maxLength)}`;
}

export type DeployFailureAnalysisInput = {
  repositoryFullName: string;
  version: string | null;
  failedJobs: string[];
  /** `tailDeployLog`済みのログ */
  log: string;
};

export function buildDeployFailureAnalysisPrompt(input: DeployFailureAnalysisInput): string {
  return `あなたはCI/CDの障害調査を手伝うエンジニアです。次の本番デプロイ（GitHub Actionsの\`deploy.yml\`）の失敗ログを読み、原因を日本語で推定してください。

対象: ${input.repositoryFullName}${input.version ? ` v${input.version}` : ""}
失敗したジョブ: ${input.failedJobs.length > 0 ? input.failedJobs.join(", ") : "不明"}

# ログ（末尾。シークレットは***へ伏せてあります）

\`\`\`
${input.log === "" ? "(ログはありません)" : input.log}
\`\`\`

# 守ること

- ログに書かれていないことを断定しない。根拠が弱いときは原因を「特定できません」とし、何を調べれば分かるかをadviceへ書く
- retryMayFix: SSH断・ネットワーク・タイムアウト・起動待ちのような一時的な失敗で、流し直せば直る見込みならtrue。コードや設定・マイグレーションの誤りならfalse
- excerpt: 原因を示すログの行を原文のまま最大${EXCERPT_MAX_LINES}行。無ければ空文字
- causeは1〜3文、adviceは1〜2文

次のJSONだけを返してください（前後の文章・コードフェンスは不要）。

{"cause": "...", "retryMayFix": true|false, "excerpt": "...", "advice": "..." または null}`;
}

function clip(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...(省略)`;
}

/** 応答を検証する。**読めなければnull**（呼び出し側が失敗として扱う） */
export function parseDeployFailureAnalysis(text: string): DeployFailureAnalysis | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.cause !== "string" || obj.cause.trim() === "") return null;

  const excerptLines = typeof obj.excerpt === "string" ? obj.excerpt.split("\n") : [];
  return {
    cause: clip(obj.cause, CAUSE_MAX_LENGTH),
    retryMayFix: obj.retryMayFix === true,
    excerpt: clip(excerptLines.slice(0, EXCERPT_MAX_LINES).join("\n"), EXCERPT_MAX_LENGTH),
    advice: typeof obj.advice === "string" && obj.advice.trim() !== "" ? clip(obj.advice, CAUSE_MAX_LENGTH) : null,
  };
}

type AnthropicMessageResponse = { content?: { type: string; text?: string }[] };

export async function analyzeDeployFailure(
  token: string,
  input: DeployFailureAnalysisInput,
): Promise<DeployFailureAnalysis> {
  const { response, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "deploy_failure_analysis",
    token,
    body: {
      max_tokens: 1024,
      messages: [{ role: "user", content: buildDeployFailureAnalysisPrompt(input) }],
    },
  });
  if (!response.ok) {
    throw new Error(`AIによる原因の分析に失敗しました (${response.status})`);
  }
  const text = json?.content?.find((block) => block.type === "text")?.text ?? "";
  const analysis = parseDeployFailureAnalysis(text);
  if (!analysis) throw new Error("AIの応答を読み取れませんでした");
  return analysis;
}
