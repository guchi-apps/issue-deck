import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import {
  addIssueLabels,
  addSubIssue,
  createComment,
  createIssue,
  fetchRepositoryLabelNames,
  updateIssue,
  type GithubApiIssue,
} from "@/lib/github/issues-api";
import { fetchAllPages } from "@/lib/github/pagination";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { checkManualStepBody } from "@/lib/manual-step-body-check";

/**
 * レビューが「手作業Issueの起票漏れ」を指摘したとき、自動修正が起票・関連付けまで完結させる（#4387）。
 *
 * **エージェントはGitHubへ書かない。** 起票したい内容を構造化された依頼として渡し、ここで
 * 対象リポジトリ・本文・HEADを検証してから、issue-deckが起票する。Codexはサンドボックス内で
 * GitHubへ書けず、Claudeの`gh`も実行中のリポジトリにしか届かないため、書き込みを1か所へ
 * 集めて権限と重複判定を揃える。
 */

export type ManualStepRequest = {
  /** 同じ作業を同定する安定キー（小文字・数字・ハイフン）。再試行・並行起動で重複起票しないための鍵 */
  key: string;
  /** 残作業の実施対象リポジトリ（`owner/repo`）。issue-deckへ登録済みのものに限る */
  targetRepository: string;
  title: string;
  body: string;
};

export type ManualStepOrigin = { repository: string; issueNumber: number; pullRequest: number };

export type ManualStepFilingResult = {
  key: string;
  repository: string;
  number: number;
  url: string;
  /** `created`は今回起票、`reused`は既存Issue（openでもcloseでも）を再利用した */
  outcome: "created" | "reused";
  /** 失敗しても起票自体は有効な付随処理の失敗（サブIssueへの紐付け失敗は含まず、例外にする） */
  warnings: string[];
};

export const MANUAL_STEP_REQUEST_LIMIT = 5;
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const TITLE_PREFIX = "[手作業] ";
const REOPEN_ATTEMPTS = 6;
const REOPEN_RETRY_DELAY_MS = 1000;

export function manualStepKeyMarker(origin: ManualStepOrigin, key: string): string {
  return `<!-- issue-deck-manual-step-key:${origin.repository}#${origin.issueNumber}:${key} -->`;
}

/** 構造だけの検証。GitHubにも登録状況にも触れない（テストしやすいよう分けてある） */
export function parseManualStepRequests(input: unknown): { requests: ManualStepRequest[]; error?: string } {
  if (!Array.isArray(input) || input.length === 0) return { requests: [], error: "起票依頼が空です" };
  if (input.length > MANUAL_STEP_REQUEST_LIMIT) return { requests: [], error: `起票依頼は${MANUAL_STEP_REQUEST_LIMIT}件までです` };
  const requests: ManualStepRequest[] = [];
  const keys = new Set<string>();
  for (const raw of input) {
    const item = raw as Partial<ManualStepRequest> | null;
    if (!item || typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) return { requests: [], error: "keyは小文字・数字・ハイフンの3〜64文字で指定してください" };
    if (keys.has(item.key)) return { requests: [], error: `keyが重複しています: ${item.key}` };
    keys.add(item.key);
    if (typeof item.targetRepository !== "string" || !REPOSITORY_PATTERN.test(item.targetRepository)) return { requests: [], error: `${item.key}: targetRepositoryが不正です` };
    if (typeof item.title !== "string" || !item.title.startsWith(TITLE_PREFIX) || item.title.length > 200) return { requests: [], error: `${item.key}: タイトルは「${TITLE_PREFIX}」で始めてください` };
    if (typeof item.body !== "string" || item.body.length > 60_000) return { requests: [], error: `${item.key}: 本文が不正です` };
    const errors = checkManualStepBody(item.body, { repositoryFullName: item.targetRepository }).filter((f) => f.severity === "error");
    if (errors.length) return { requests: [], error: `${item.key}: 本文が手作業Issueの書式を満たしません（${errors.map((f) => f.message).join(" / ")}）` };
    if (/(token|secret|password|api[_-]?key)\s*[=:]\s*[A-Za-z0-9_\-+/]{16,}/i.test(item.body)) return { requests: [], error: `${item.key}: 秘密値らしき文字列が含まれています` };
    requests.push({ key: item.key, targetRepository: item.targetRepository, title: item.title, body: item.body });
  }
  return { requests };
}

function withOrigin(request: ManualStepRequest, origin: ManualStepOrigin): string {
  const refs = `- 起点Issue: ${origin.repository}#${origin.issueNumber}\n- 対応PR: ${origin.repository}#${origin.pullRequest}`;
  const body = request.body.includes("## 関連") ? request.body : `${request.body.trimEnd()}\n\n## 関連\n${refs}`;
  const withRefs = body.includes(`${origin.repository}#${origin.issueNumber}`) ? body : `${body.trimEnd()}\n${refs}`;
  return `${withRefs.trimEnd()}\n\n${manualStepKeyMarker(origin, request.key)}\n`;
}

const inFlight = new Map<string, Promise<ManualStepFilingResult>>();

async function listManualStepIssues(owner: string, repo: string, token: string): Promise<GithubApiIssue[]> {
  const items = await fetchAllPages<GithubApiIssue>(
    `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&labels=${encodeURIComponent(MANUAL_STEP_LABEL)}&per_page=100&sort=created&direction=asc`,
    token,
  );
  return items.filter((item) => !item.pull_request);
}

function findExisting(issues: GithubApiIssue[], marker: string, title: string): GithubApiIssue | undefined {
  // 起票済み（open・closeどちらでも）を最優先で再利用する。完了済みの記録を尊重し、再起票しない。
  return issues.find((i) => (i.body ?? "").includes(marker)) ?? issues.find((i) => i.state === "open" && i.title.trim() === title.trim());
}

async function fileOne(request: ManualStepRequest, origin: ManualStepOrigin): Promise<ManualStepFilingResult> {
  const registered = await db.repository.findFirst({ where: { fullName: request.targetRepository }, include: { installation: true } });
  if (!registered) throw new Error(`${request.targetRepository}はissue-deckへ登録されていないため起票できません`);
  const token = await getInstallationToken(registered.installation.installationId);
  const [owner, repo] = request.targetRepository.split("/");
  const marker = manualStepKeyMarker(origin, request.key);
  const warnings: string[] = [];

  const labels = await fetchRepositoryLabelNames(owner, repo, token);
  if (!labels.has(MANUAL_STEP_LABEL)) throw new Error(`${request.targetRepository}に${MANUAL_STEP_LABEL}ラベルが定義されていません`);

  let issue = findExisting(await listManualStepIssues(owner, repo, token), marker, request.title);
  let outcome: "created" | "reused" = "reused";
  if (!issue) {
    issue = await createIssue(owner, repo, token, { title: request.title, body: withOrigin(request, origin), labels: [MANUAL_STEP_LABEL] });
    outcome = "created";
    // 並行起動で同じ依頼が同時に作られたら、番号の若い方だけを残す。
    const duplicates = (await listManualStepIssues(owner, repo, token)).filter((i) => (i.body ?? "").includes(marker));
    const keeper = duplicates[0];
    if (keeper && keeper.number !== issue.number) {
      await updateIssue(owner, repo, issue.number, token, { state: "closed", state_reason: "not_planned" }).catch(() => undefined);
      issue = keeper;
      outcome = "reused";
    }
  }

  // 実在・ラベル・本文のマーカーを再取得して確かめる。起票しただけで成功とみなさない。
  const verify = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${issue.number}`, token);
  if (!verify.ok) throw new Error(`${request.targetRepository}#${issue.number}を確認できません（HTTP ${verify.status}）`);
  const verified = (await verify.json()) as GithubApiIssue;
  if (!verified.labels?.some((l) => (typeof l === "string" ? l : l.name) === MANUAL_STEP_LABEL)) {
    await addIssueLabels(owner, repo, issue.number, token, [MANUAL_STEP_LABEL]);
  }
  if (!(verified.body ?? "").includes(marker) && outcome === "created") throw new Error(`${request.targetRepository}#${issue.number}の本文を確認できません`);

  // 起点Issueへサブissueとして紐付ける。紐付けは完了条件なので、失敗は成功扱いにせず例外にする。
  // 起点と起票先が別Installationでも書けるよう、起点リポジトリ自身のInstallation tokenを使う。
  const originRegistered = await db.repository.findFirst({ where: { fullName: origin.repository }, include: { installation: true } });
  if (!originRegistered) throw new Error(`${origin.repository}はissue-deckへ登録されていないためサブIssueへ紐付けできません`);
  const originToken = await getInstallationToken(originRegistered.installation.installationId);
  const [originOwner, originRepo] = origin.repository.split("/");
  const linked = await fetchAllPages<{ id: number }>(`${GITHUB_API}/repos/${originOwner}/${originRepo}/issues/${origin.issueNumber}/sub_issues?per_page=100`, originToken);
  if (!linked.some((s) => s.id === verified.id)) {
    try {
      await addSubIssue(originOwner, originRepo, origin.issueNumber, originToken, verified.id);
    } catch (error) {
      throw new Error(`${request.targetRepository}#${issue.number}を${origin.repository}#${origin.issueNumber}のサブIssueへ紐付けできません: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { key: request.key, repository: request.targetRepository, number: issue.number, url: verified.html_url, outcome, warnings };
}

/** 同一キーの同時実行を1つにまとめる（同じプロセス内。別プロセスはマーカー再確認で収束する） */
function fileOnce(request: ManualStepRequest, origin: ManualStepOrigin): Promise<ManualStepFilingResult> {
  const id = `${origin.repository}#${origin.issueNumber}:${request.key}`;
  const running = inFlight.get(id);
  if (running) return running;
  const promise = fileOne(request, origin).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

export function renderFilingComment(origin: ManualStepOrigin, results: ManualStepFilingResult[]): string {
  const lines = results.map((r) => `- ${r.repository}#${r.number}（${r.outcome === "created" ? "新規起票" : "既存を再利用"}）: ${r.url}`);
  return `レビューで指摘された手作業Issueの起票漏れを、自動修正で解消しました。\n\n${lines.join("\n")}\n\n起点Issue: ${origin.repository}#${origin.issueNumber} / PR: ${origin.repository}#${origin.pullRequest}\n\n<!-- issue-deck-source:claude-review-fix -->\n<!-- issue-deck-manual-step-filed:${results.map((r) => r.key).sort().join(",")} -->`;
}

/** すべて成功したときだけ結果を返す。1件でも失敗すれば例外にし、成功扱いにしない */
export async function fileManualSteps(requests: ManualStepRequest[], origin: ManualStepOrigin): Promise<ManualStepFilingResult[]> {
  const results: ManualStepFilingResult[] = [];
  for (const request of requests) results.push(await fileOnce(request, origin));
  const originRepo = await db.repository.findFirst({ where: { fullName: origin.repository }, include: { installation: true } });
  if (originRepo) {
    const token = await getInstallationToken(originRepo.installation.installationId);
    const [owner, repo] = origin.repository.split("/");
    const body = renderFilingComment(origin, results);
    const marker = `<!-- issue-deck-manual-step-filed:${results.map((r) => r.key).sort().join(",")} -->`;
    for (const number of [origin.issueNumber, origin.pullRequest]) {
      const existing = await fetchAllPages<{ body?: string }>(`${GITHUB_API}/repos/${origin.repository}/issues/${number}/comments?per_page=100`, token);
      if (existing.some((c) => (c.body ?? "").includes(marker))) continue;
      await createComment(owner, repo, number, token, { body });
    }
  }
  return results;
}

/**
 * 同じHEADのまま再レビューを起動する（PRをclose→reopen。`pull_request: reopened`でレビューが走る）。
 * HEADが変わっていたら何もせず失敗にする。再起動できなかった場合は呼び出し元が理由を表示する。
 */
export async function restartReviewAtSameHead(repository: string, pullRequest: number, headSha: string): Promise<void> {
  const registered = await db.repository.findFirst({ where: { fullName: repository }, include: { installation: true } });
  if (!registered) throw new Error("登録済みリポジトリが見つかりません");
  const token = await getInstallationToken(registered.installation.installationId);
  const base = `${GITHUB_API}/repos/${repository}/pulls/${pullRequest}`;
  const current = await githubFetch(base, token);
  if (!current.ok) throw new Error(`PRを確認できません（HTTP ${current.status}）`);
  const pr = (await current.json()) as { state: string; head: { sha: string } };
  if (pr.head.sha !== headSha) throw new Error("PRのHEADが変わったため再レビューを起動しません");
  if (pr.state !== "open") throw new Error("PRがopenではないため再レビューを起動しません");
  const close = await githubFetch(base, token, { method: "PATCH", body: { state: "closed" } });
  if (!close.ok) throw new Error(`PRをcloseできません（HTTP ${close.status}）`);
  let reopened = false;
  for (let attempt = 0; attempt < REOPEN_ATTEMPTS && !reopened; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, REOPEN_RETRY_DELAY_MS * 2 ** (attempt - 1)));
    reopened = (await githubFetch(base, token, { method: "PATCH", body: { state: "open" } }).catch(() => null))?.ok ?? false;
  }
  if (!reopened) {
    // closedのまま残ると系列が止まるので、監視できる形（PRコメント＋確認待ちラベル）で人へ引き上げる。
    const [owner, repo] = repository.split("/");
    await createComment(owner, repo, pullRequest, token, {
      body: `再レビューの起動でPRをcloseしましたが、reopenに失敗しました。**PRがcloseされたままです。** 手動でreopenしてください。\n\n<!-- issue-deck-source:review-restart-reopen-failed -->`,
    }).catch(() => undefined);
    await addIssueLabels(owner, repo, pullRequest, token, ["00.check-user", "01.check-blocked"]).catch(() => undefined);
    throw new Error("PRのreopenに失敗しました。PRがcloseされたままです。手動でreopenしてください");
  }
}
