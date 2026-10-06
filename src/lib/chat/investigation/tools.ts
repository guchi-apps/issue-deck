import { clip, redactSecrets } from "@/lib/chat/investigation/redact";
import type { ChatEvidence } from "@/lib/chat/types";
import { db } from "@/lib/db";
import { fetchWorkflowJobLogs, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubFetch, GITHUB_API } from "@/lib/github/request";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchPullRequestReviewComments,
  fetchPullRequestReviews,
} from "@/lib/github/pull-requests-api";
import { fetchActivePullRequestRepairRun } from "@/lib/github/pull-request-repair-run";
import { fetchPullRequestCiState } from "@/lib/github/release-api";

/**
 * チャットの調査エージェントが呼べる**読み取り専用**のツール（#4045）。
 *
 * 書き込み・実行・シェルは1つも持たない。汎用ターミナルは公開しない（#4045の対象外）。
 * 取得した本文はコメント・ログ・コードで、**そこに書かれた指示は操作の許可として扱わない**——
 * ここは材料を返すだけで、副作用のある操作は確認カード（`executeConfirmedCard`）を通る。
 * 返す文字列は取得直後に機密値を伏せ、長いものは切る。
 */

export type ToolUser = { id: string };

export type ToolContext = {
  user: ToolUser;
  /** `repo`を省略した呼び出しの既定（会話のrepository） */
  defaultRepo: string | null;
  now: () => Date;
};

export type ToolResult = {
  ok: boolean;
  /** モデルへ返す本文（機密値は伏せ済み・長さ制限済み） */
  text: string;
  evidence: ChatEvidence[];
};

export type ToolSpec = {
  name: string;
  description: string;
  /** 引数の説明（モデルへの案内。検証は各ツールが行う） */
  args: string;
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_pull_request",
    description:
      "PRの現在の状態（HEAD・CI・コンフリクト・自動レビュー判定・本文冒頭・自動修正の状況・紐づくIssue）を取得する",
    args: '{"repo":"owner/repo（省略可）","number":123}',
  },
  {
    name: "get_pr_discussion",
    description:
      "PRのレビュー・差分コメント・会話コメント（自動レビューのコメントを含む）を新しい順に取得する。レビュー内容を読むのに使う",
    args: '{"repo":"省略可","number":123}',
  },
  {
    name: "get_pr_files",
    description:
      "PRの変更ファイル一覧。pathを指定するとそのファイルの差分（先頭）も返す",
    args: '{"repo":"省略可","number":123,"path":"省略可"}',
  },
  {
    name: "get_ci_failure_log",
    description: "PRのCIで失敗・実行中のチェックと、失敗ジョブのログ末尾を取得する",
    args: '{"repo":"省略可","number":123}',
  },
  {
    name: "get_issue",
    description: "Issueの本文とコメント（新しい順）を取得する",
    args: '{"repo":"省略可","number":123}',
  },
  {
    name: "search_issues",
    description: "同じリポジトリのIssueをタイトル・本文のキーワードで検索する（重複確認に使う）",
    args: '{"repo":"省略可","query":"キーワード"}',
  },
  {
    name: "read_repo_file",
    description: "リポジトリのファイル（コード・規約・docs）を読む。refを省略するとデフォルトブランチ",
    args: '{"repo":"省略可","path":"docs/chat.md","ref":"省略可"}',
  },
  {
    name: "search_repo_files",
    description:
      "リポジトリのファイルをパスのキーワードで探す（番号なしの設計相談で、関連する画面・コードのファイルを見つけるのに使う。read_repo_fileの前に使う）",
    args: '{"repo":"省略可","query":"パスに含まれる語（例: work, calendar）","ref":"省略可"}',
  },
  {
    name: "get_repair_state",
    description: "PRの自動修正（実行中のrun・系列の状態）をDBの記録から取得する",
    args: '{"repo":"省略可","number":123}',
  },
];

const MAX_ITEMS = 12;
const BODY_CLIP = 1500;

type Args = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function fail(text: string): ToolResult {
  return { ok: false, text, evidence: [] };
}

type Access = {
  fullName: string;
  owner: string;
  repo: string;
  repositoryId: string;
  token: string;
};

async function resolveAccess(ctx: ToolContext, args: Args): Promise<Access | ToolResult> {
  const fullName = str(args.repo) ?? ctx.defaultRepo;
  if (!fullName || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    return fail("repoが分かりません。owner/repo の形で指定してください。");
  }
  const repository = await findRepositoryByFullName(ctx.user.id, fullName);
  if (!repository) return fail(`${fullName} は見つからないか、アクセス権がありません（権限不足）。`);
  const [owner, repo] = fullName.split("/");
  const token = await getInstallationToken(repository.installation.installationId);
  return { fullName, owner, repo, repositoryId: repository.id, token };
}

function isFailure(value: Access | ToolResult): value is ToolResult {
  return "evidence" in value;
}

function evidence(ctx: ToolContext, label: string, url: string | null, ref: string | null): ChatEvidence {
  return { label, url, fetchedAt: ctx.now().toISOString(), ref };
}

export function linkedIssueNumber(headRef: string): number | null {
  const match = /^issue-(\d+)$/.exec(headRef);
  return match ? Number(match[1]) : null;
}

async function getPullRequest(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const number = int(args.number);
  if (!number) return fail("numberが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const { owner, repo, token, fullName } = access;
  const pr = await fetchPullRequest(owner, repo, number, token);
  const [ci, activeRepair] = await Promise.all([
    fetchPullRequestCiState(owner, repo, number, token).catch(() => null),
    fetchActivePullRequestRepairRun(fullName, number).catch(() => null),
  ]);
  const verdict = parsePullRequestReviewVerdict(pr.body);
  const lines = [
    `PR ${fullName}#${number}「${pr.title}」`,
    `状態: ${pr.merged ? "マージ済み" : pr.state}${pr.draft ? "（ドラフト）" : ""}`,
    `ブランチ: ${pr.head.ref} → ${pr.base.ref}`,
    `HEAD: ${pr.head.sha}`,
    `コミット数: ${pr.commits} / 変更ファイル: ${pr.changed_files}（+${pr.additions} −${pr.deletions}）`,
    ci
      ? `CI: ${ci.ciState} / コンフリクト: ${ci.mergeable === false ? "あり" : ci.mergeable === true ? "なし" : "判定中・不明"} / 自動マージ判定: ${JSON.stringify(ci.mergeJudgement)}`
      : "CI: 取得に失敗しました（未確認）",
    verdict
      ? `自動レビュー判定: ${verdict.reviewLabel}（${verdict.reviewKind}）${verdict.reviewedSha ? ` 判定時のHEAD=${verdict.reviewedSha}${verdict.reviewedSha.startsWith(pr.head.sha.slice(0, 7)) || pr.head.sha.startsWith(verdict.reviewedSha) ? "（現在のHEADと一致）" : "（現在のHEADと不一致＝古い判定）"}` : "（判定時のHEAD不明）"}${verdict.confirmLabel ? ` / ユーザーの確認: ${verdict.confirmLabel}` : ""}${verdict.riskReasons.length ? ` / リスク: ${verdict.riskReasons.join("、")}` : ""}`
      : "自動レビュー判定: 記録なし",
    activeRepair ? `自動修正: 実行中（${activeRepair.kind}、開始 ${activeRepair.startedAt}）` : "自動修正: 実行中のものなし",
    `紐づくIssue: ${linkedIssueNumber(pr.head.ref) ?? "なし（issue-<番号>ブランチではない）"}`,
    `本文冒頭:\n${clip(pr.body ?? "", BODY_CLIP)}`,
  ];
  return {
    ok: true,
    text: redactSecrets(lines.join("\n")),
    evidence: [evidence(ctx, `${fullName}#${number} のPR状態`, pr.html_url, `HEAD ${pr.head.sha.slice(0, 7)}`)],
  };
}

async function getPrDiscussion(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const number = int(args.number);
  if (!number) return fail("numberが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const { owner, repo, token, fullName } = access;
  const [reviews, inline, comments] = await Promise.all([
    fetchPullRequestReviews(owner, repo, number, token),
    fetchPullRequestReviewComments(owner, repo, number, token),
    fetchCommentsForIssue(owner, repo, number, token),
  ]);
  const parts: string[] = [];
  parts.push(`## レビュー（${reviews.length}件）`);
  for (const review of reviews.slice(-MAX_ITEMS).reverse()) {
    parts.push(`- ${review.user?.login ?? "?"} ${review.state} ${review.submitted_at ?? ""}\n  ${clip(review.body ?? "", 700)}`);
  }
  parts.push(`## 差分コメント（${inline.length}件）`);
  for (const comment of inline.slice(-MAX_ITEMS).reverse()) {
    parts.push(`- ${comment.user?.login ?? "?"} ${comment.path}:${comment.line ?? "?"} ${comment.created_at}\n  ${clip(comment.body ?? "", 500)}`);
  }
  parts.push(`## 会話コメント（${comments.length}件・新しい順）`);
  for (const comment of comments.slice(-MAX_ITEMS).reverse()) {
    parts.push(`- ${comment.user?.login ?? "?"} ${comment.created_at} ${comment.html_url ?? ""}\n  ${clip(comment.body ?? "", 1200)}`);
  }
  const url = `https://github.com/${fullName}/pull/${number}`;
  return {
    ok: true,
    text: redactSecrets(parts.join("\n")),
    evidence: [evidence(ctx, `${fullName}#${number} のレビュー・コメント`, url, `レビュー${reviews.length}件・コメント${comments.length + inline.length}件`)],
  };
}

async function getPrFiles(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const number = int(args.number);
  if (!number) return fail("numberが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const { owner, repo, token, fullName } = access;
  const files = await fetchPullRequestFiles(owner, repo, number, token);
  const path = str(args.path);
  const lines = files.slice(0, 60).map((f) => `${f.status} ${f.filename} (+${f.additions} −${f.deletions})`);
  let patch = "";
  if (path) {
    const target = files.find((f) => f.filename === path);
    patch = target ? `\n## ${path} の差分\n${clip(target.patch ?? "（差分なし・バイナリ）", 4000)}` : `\n${path} は変更ファイルにありません。`;
  }
  return {
    ok: true,
    text: redactSecrets(`変更ファイル ${files.length}件${files.length > 60 ? "（先頭60件）" : ""}\n${lines.join("\n")}${patch}`),
    evidence: [evidence(ctx, `${fullName}#${number} の変更ファイル`, `https://github.com/${fullName}/pull/${number}/files`, null)],
  };
}

async function getCiFailureLog(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const number = int(args.number);
  if (!number) return fail("numberが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const { owner, repo, token, fullName } = access;
  const ci = await fetchPullRequestCiState(owner, repo, number, token);
  const bad = ci.ciChecks.filter((c) => c.conclusion !== null && !["success", "skipped", "neutral"].includes(c.conclusion));
  const running = ci.ciChecks.filter((c) => c.conclusion === null);
  const lines = [
    `CI集約: ${ci.ciState}（チェック${ci.ciChecks.length}件）`,
    ...ci.ciChecks.map((c) => `- ${c.name}: ${c.status}/${c.conclusion ?? "未完了"} ${c.htmlUrl ?? ""}`),
  ];
  const evidenceItems: ChatEvidence[] = [];
  const runIds = [...new Set(bad.map((c) => c.runId).filter((id): id is number => id !== null))].slice(0, 2);
  for (const runId of runIds) {
    try {
      const jobs = await fetchWorkflowRunJobs(owner, repo, runId, token);
      const failed = jobs.filter((j) => j.conclusion === "failure" && j.id !== undefined).slice(0, 2);
      for (const job of failed) {
        const log = await fetchWorkflowJobLogs(owner, repo, job.id as number, token);
        lines.push(`## 失敗ジョブ ${job.name}（run ${runId}）のログ末尾\n${clip(log, 3500, "tail")}`);
        evidenceItems.push(evidence(ctx, `${job.name} の失敗ログ`, job.html_url ?? null, `run ${runId}`));
      }
      if (failed.length === 0) lines.push(`run ${runId}: 失敗ジョブを特定できませんでした（未確認）`);
    } catch (error) {
      lines.push(`run ${runId} のログ取得に失敗しました（未確認）: ${error instanceof Error ? error.message.slice(0, 120) : "不明"}`);
    }
  }
  if (bad.length === 0 && running.length === 0) lines.push("失敗しているチェックはありません。");
  return {
    ok: true,
    text: redactSecrets(lines.join("\n")),
    evidence: [
      evidence(ctx, `${fullName}#${number} のCI`, `https://github.com/${fullName}/pull/${number}/checks`, `チェック${ci.ciChecks.length}件`),
      ...evidenceItems,
    ],
  };
}

async function getIssue(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const number = int(args.number);
  if (!number) return fail("numberが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const { owner, repo, token, fullName, repositoryId } = access;
  const issue = await db.issue.findFirst({
    where: { repositoryId, number },
    include: { labels: true },
  });
  if (!issue) return fail(`${fullName}#${number} は同期済みのIssueに見つかりません（PRの場合は get_pull_request を使ってください）。`);
  const comments = await fetchCommentsForIssue(owner, repo, number, token).catch(() => null);
  const lines = [
    `Issue ${fullName}#${number}「${issue.title}」 状態: ${issue.state} ラベル: ${issue.labels.map((l) => l.name).join(", ") || "なし"}`,
    `本文:\n${clip(issue.body ?? "", 3000)}`,
    comments
      ? `コメント${comments.length}件（新しい順）:\n${comments
          .slice(-MAX_ITEMS)
          .reverse()
          .map((c) => `- ${c.user?.login ?? "?"} ${c.created_at}\n  ${clip(c.body ?? "", 900)}`)
          .join("\n")}`
      : "コメントの取得に失敗しました（未確認）",
  ];
  return {
    ok: true,
    text: redactSecrets(lines.join("\n")),
    evidence: [evidence(ctx, `${fullName}#${number}`, issue.htmlUrl, `更新 ${issue.githubUpdatedAt.toISOString()}`)],
  };
}

export function searchTerms(query: string): string[] {
  return query
    .split(/[\s、。,.　/・]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 5);
}

async function searchIssues(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const query = str(args.query);
  if (!query) return fail("queryが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const terms = searchTerms(query);
  if (terms.length === 0) return fail("検索語が短すぎます。");
  const rows = await db.issue.findMany({
    where: {
      repositoryId: access.repositoryId,
      OR: terms.flatMap((term) => [{ title: { contains: term } }, { body: { contains: term } }]),
    },
    orderBy: { githubUpdatedAt: "desc" },
    take: 8,
    select: { number: true, title: true, state: true, htmlUrl: true },
  });
  const text = rows.length
    ? rows.map((r) => `- #${r.number} [${r.state}] ${r.title} ${r.htmlUrl}`).join("\n")
    : "該当するIssueはありません（同期済みの範囲）。";
  return {
    ok: true,
    text: redactSecrets(`検索語: ${terms.join(" / ")}\n${text}`),
    evidence: rows.slice(0, 3).map((r) => evidence(ctx, `#${r.number} ${r.title}`, r.htmlUrl, r.state)),
  };
}

/** 読んでよいパスか。リポジトリ外へ出る表現と、環境変数・鍵の置き場を断る */
export function isReadablePath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("..") || path.includes("\0")) return false;
  const lower = path.toLowerCase();
  return !/(^|\/)(\.env($|\.)|id_rsa|id_ed25519|.*\.pem$|.*\.key$|secrets?\/)/.test(lower);
}

async function readRepoFile(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const path = str(args.path);
  if (!path || !isReadablePath(path)) return fail("このパスは読めません（リポジトリ内の通常ファイルだけ）。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const ref = str(args.ref);
  const url = `${GITHUB_API}/repos/${access.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const res = await githubFetch(url, access.token);
  if (!res.ok) return fail(`${access.fullName}:${path} を読めませんでした（${res.status}）。`);
  const file = (await res.json()) as { content?: string; encoding?: string; html_url?: string; sha?: string; type?: string };
  if (file.type && file.type !== "file") return fail(`${path} はファイルではありません。`);
  if (!file.content || file.encoding !== "base64") return fail(`${path} の中身を取得できませんでした。`);
  const text = Buffer.from(file.content, "base64").toString("utf8");
  return {
    ok: true,
    text: redactSecrets(`# ${access.fullName}:${path}\n${clip(text, 7000)}`),
    evidence: [evidence(ctx, `${path}`, file.html_url ?? null, ref ? `ref ${ref}` : `blob ${file.sha?.slice(0, 7) ?? ""}`)],
  };
}

const IGNORED_DIRS = /(^|\/)(node_modules|\.next|dist|build|coverage|\.git|vendor)\//;
const MAX_LISTED_FILES = 40;

/** パスの部分一致でファイルを探す（読み取りだけ）。内容は`read_repo_file`で読む */
async function searchRepoFiles(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const query = str(args.query)?.toLowerCase();
  if (!query) return fail("queryが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const ref = str(args.ref) ?? "HEAD";
  const res = await githubFetch(
    `${GITHUB_API}/repos/${access.fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    access.token,
  );
  if (!res.ok) return fail(`${access.fullName} のファイル一覧を取得できませんでした（${res.status}）。`);
  const tree = (await res.json()) as { tree?: { path: string; type: string }[]; truncated?: boolean };
  const terms = query.split(/\s+/).filter(Boolean);
  const hits = (tree.tree ?? [])
    .filter((n) => n.type === "blob" && !IGNORED_DIRS.test(n.path) && isReadablePath(n.path))
    .filter((n) => terms.every((t) => n.path.toLowerCase().includes(t)))
    .map((n) => n.path);
  const shown = hits.slice(0, MAX_LISTED_FILES);
  const notes = [
    hits.length > shown.length ? `（他${hits.length - shown.length}件は省略。語を絞ってください）` : "",
    tree.truncated ? "（リポジトリが大きく一覧が途中で切れています。見つからなくても存在しないとは言えません）" : "",
  ].filter(Boolean);
  return {
    ok: true,
    text: shown.length
      ? `# ${access.fullName} のパス「${query}」の一致 ${hits.length}件\n${shown.join("\n")}${notes.length ? `\n${notes.join("\n")}` : ""}`
      : `パス「${query}」に一致するファイルはありません。${notes.join("")}`,
    evidence: [evidence(ctx, `${access.fullName} のファイル検索「${query}」`, null, ref)],
  };
}

async function getRepairState(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const number = int(args.number);
  if (!number) return fail("numberが必要です。");
  const access = await resolveAccess(ctx, args);
  if (isFailure(access)) return access;
  const where = { repositoryFullName: access.fullName, pullRequestNumber: number };
  const [runs, loop] = await Promise.all([
    db.pullRequestRepairRun.findMany({ where, orderBy: { startedAt: "desc" }, take: 5 }),
    db.pullRequestAutoRepairLoop.findFirst({ where }),
  ]);
  const lines = [
    ...runs.map((r) => `- ${r.kind}: ${r.status} 開始 ${r.startedAt.toISOString()}${r.finishedAt ? ` 終了 ${r.finishedAt.toISOString()}` : ""} ${r.runUrl ?? ""}`),
    loop
      ? `系列: ${loop.status} ラウンド${loop.round}/${loop.maxRounds}${loop.stopReason ? ` 停止理由 ${loop.stopReason}` : ""}`
      : "系列: 記録なし",
  ];
  return {
    ok: true,
    text: lines.join("\n") || "記録なし",
    evidence: [evidence(ctx, `${access.fullName}#${number} の自動修正記録`, null, null)],
  };
}

const HANDLERS: Record<string, (ctx: ToolContext, args: Args) => Promise<ToolResult>> = {
  get_pull_request: getPullRequest,
  get_pr_discussion: getPrDiscussion,
  get_pr_files: getPrFiles,
  get_ci_failure_log: getCiFailureLog,
  get_issue: getIssue,
  search_issues: searchIssues,
  read_repo_file: readRepoFile,
  search_repo_files: searchRepoFiles,
  get_repair_state: getRepairState,
};

export function isKnownTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

/** ツールを実行する。**例外は呼び出し元へ投げず、失敗として返す**（取得失敗を「問題なし」にしない） */
export async function runTool(ctx: ToolContext, name: string, args: Args): Promise<ToolResult> {
  if (!isKnownTool(name)) return fail(`未知のツールです: ${name}`);
  try {
    return await HANDLERS[name](ctx, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`取得に失敗しました（${name}）: ${redactSecrets(message).slice(0, 200)}`);
  }
}
