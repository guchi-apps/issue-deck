/**
 * 実装セッションが「他リポジトリにも修正が要る」と判断したとき、issue-deckがそのリポジトリへ
 * 子Issueを起票し、起点IssueのサブIssueへ紐付け、そのまま実装セッションを起動する（#5421）。
 *
 * **エージェントはGitHubへ書かない。** 起票したい内容を構造化された依頼として
 * `scripts/report-cross-repo-issue.sh`で送り、ここで検証してからissue-deckが起票する。
 * 手作業Issueの自動起票（#4387 `manual-step-filing.ts`）と同じ考え方で、書き込みを1か所へ集めて
 * 重複判定と権限を揃える（Codexはサンドボックス内からGitHubへ書けず、ローカルの`gh`は人のトークン）。
 *
 * GitHub・DB・起動の操作は`CrossRepoDeps`として受け取る（実体は`cross-repo-filing-deps.ts`）。
 */

export type CrossRepoIssueRequest = {
  /** 同じ依頼を同定する安定キー（小文字・数字・ハイフン）。再送しても重複起票しないための鍵 */
  key: string;
  /** 起票先（`owner/repo`）。issue-deckへ登録済みで、起点とは別のリポジトリに限る */
  targetRepository: string;
  title: string;
  /** 子Issueの本文（目的・完了条件）。起点へのリンク・前提条件・マーカーはここで足す */
  body: string;
  /** 子が起点の実装（developへのマージ）を待つ必要があるか。`## 前提条件`へ起点を書く */
  waitForOrigin: boolean;
  /** 起票後に子の実装セッションを起動するか（既定true） */
  launch: boolean;
};

export type CrossRepoOrigin = { repository: string; issueNumber: number };

export type CrossRepoLaunchOutcome =
  | { status: "launched"; hostName: string; agent: string; labelWarning?: string }
  | { status: "not_requested" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type CrossRepoFilingResult = {
  key: string;
  repository: string;
  number: number;
  url: string;
  /** `created`は今回起票、`reused`は同じキーで起票済みのIssueを再利用した */
  outcome: "created" | "reused";
  launch: CrossRepoLaunchOutcome;
};

export type CrossRepoIssueRef = { number: number; id: number; url: string; state: "open" | "closed" };

export type CrossRepoDeps = {
  isRegistered(repository: string): Promise<boolean>;
  /** マーカーを本文に含むIssueを探す。**取得に失敗したら投げる**（「無い」と区別するため） */
  findIssueByMarker(repository: string, marker: string): Promise<CrossRepoIssueRef | null>;
  createIssue(repository: string, input: { title: string; body: string }): Promise<CrossRepoIssueRef>;
  listSubIssueIds(origin: CrossRepoOrigin): Promise<number[]>;
  addSubIssue(origin: CrossRepoOrigin, childId: number): Promise<void>;
  /** 起点Issueを直近に起動したホスト・エージェント。無ければnull */
  findOriginLaunch(origin: CrossRepoOrigin): Promise<{ hostName: string; agent: string } | null>;
  launch(input: { repository: string; issueNumber: number; hostName: string; agent: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 起動できた子へ`11.local`を付ける（無人実行との二重起動防止。「実装を開始」と同じく積めたときだけ） */
  markLocal(repository: string, issueNumber: number): Promise<void>;
  comment(origin: CrossRepoOrigin, body: string): Promise<void>;
};

export const CROSS_REPO_REQUEST_LIMIT = 5;
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const SECRET_PATTERN = /(token|secret|password|api[_-]?key)\s*[=:]\s*[A-Za-z0-9_\-+/]{16,}/i;

export function crossRepoKeyMarker(origin: CrossRepoOrigin, key: string): string {
  return `<!-- issue-deck-cross-repo-key:${origin.repository}#${origin.issueNumber}:${key} -->`;
}

/** 構造だけの検証。GitHubにも登録状況にも触れない */
export function parseCrossRepoIssueRequests(
  input: unknown,
  origin: CrossRepoOrigin,
): { requests: CrossRepoIssueRequest[]; error?: string } {
  if (!Array.isArray(input) || input.length === 0) return { requests: [], error: "起票依頼が空です" };
  if (input.length > CROSS_REPO_REQUEST_LIMIT) return { requests: [], error: `起票依頼は${CROSS_REPO_REQUEST_LIMIT}件までです` };
  const requests: CrossRepoIssueRequest[] = [];
  const keys = new Set<string>();
  for (const raw of input) {
    const item = raw as Partial<CrossRepoIssueRequest> | null;
    if (!item || typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) {
      return { requests: [], error: "keyは小文字・数字・ハイフンの3〜64文字で指定してください" };
    }
    if (keys.has(item.key)) return { requests: [], error: `keyが重複しています: ${item.key}` };
    keys.add(item.key);
    if (typeof item.targetRepository !== "string" || !REPOSITORY_PATTERN.test(item.targetRepository)) {
      return { requests: [], error: `${item.key}: targetRepositoryが不正です` };
    }
    if (item.targetRepository.toLowerCase() === origin.repository.toLowerCase()) {
      return { requests: [], error: `${item.key}: 起点と同じリポジトリには起票しません（同じリポジトリの作業はこのIssueで行う）` };
    }
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title || title.length > 200) return { requests: [], error: `${item.key}: タイトルは1〜200文字で指定してください` };
    if (typeof item.body !== "string" || !item.body.trim() || item.body.length > 60_000) {
      return { requests: [], error: `${item.key}: 本文が空か長すぎます` };
    }
    if (SECRET_PATTERN.test(item.body)) return { requests: [], error: `${item.key}: 秘密値らしき文字列が含まれています` };
    if (item.waitForOrigin !== undefined && typeof item.waitForOrigin !== "boolean") {
      return { requests: [], error: `${item.key}: waitForOriginは真偽値で指定してください` };
    }
    if (item.launch !== undefined && typeof item.launch !== "boolean") {
      return { requests: [], error: `${item.key}: launchは真偽値で指定してください` };
    }
    requests.push({
      key: item.key,
      targetRepository: item.targetRepository,
      title,
      body: item.body,
      waitForOrigin: item.waitForOrigin ?? false,
      launch: item.launch ?? true,
    });
  }
  return { requests };
}

/** 子Issueの本文。依頼の本文に、前提条件（起点を待つとき）・関連・重複判定用マーカーを足す */
export function renderChildBody(request: CrossRepoIssueRequest, origin: CrossRepoOrigin): string {
  const originRef = `${origin.repository}#${origin.issueNumber}`;
  const parts = [request.body.trimEnd()];
  if (request.waitForOrigin && !/^## 前提条件/m.test(request.body)) {
    parts.push(`## 前提条件\n\n- 先に完了している必要があるIssue・PR: ${originRef}（実装PRのdevelopへのマージ）`);
  }
  parts.push(`## 関連\n\n- 起点: ${originRef}（実装中に、このリポジトリにも修正が要ると判断して起票した）`);
  return `${parts.join("\n\n")}\n\n${crossRepoKeyMarker(origin, request.key)}\n`;
}

function describeLaunch(launch: CrossRepoLaunchOutcome): string {
  switch (launch.status) {
    case "launched":
      return `実装セッションを起動しました（${launch.hostName}・${launch.agent}）${launch.labelWarning ? `。ただし${launch.labelWarning}` : ""}`;
    case "not_requested":
      return "起動はしていません（起票のみの依頼）";
    case "skipped":
      return `起動を見送りました: ${launch.reason}`;
    case "failed":
      return `起動できませんでした: ${launch.reason}`;
  }
}

export function renderOriginComment(origin: CrossRepoOrigin, results: CrossRepoFilingResult[]): string {
  const lines = results.map(
    (r) => `- ${r.repository}#${r.number}（${r.outcome === "created" ? "新規起票" : "起票済みを再利用"}）: ${r.url}\n  - ${describeLaunch(r.launch)}`,
  );
  const needsHand = results.some((r) => r.launch.status === "skipped" || r.launch.status === "failed");
  const tail = needsHand
    ? "\n\n起動できなかった子Issueは、issue-deckの画面から「実装を開始」で起動してください。"
    : "";
  return `このIssueの実装中に、他リポジトリにも修正が要ると判断したため、子Issueを起票してサブIssueへ紐付けました。\n\n${lines.join("\n")}${tail}\n\n<!-- issue-deck-source:cross-repo-filing -->\n<!-- issue-deck-agent:implementer -->`;
}

async function launchChild(
  request: CrossRepoIssueRequest,
  issue: CrossRepoIssueRef,
  origin: CrossRepoOrigin,
  deps: CrossRepoDeps,
): Promise<CrossRepoLaunchOutcome> {
  if (!request.launch) return { status: "not_requested" };
  if (issue.state === "closed") return { status: "skipped", reason: "子Issueはクローズ済みです" };
  const origLaunch = await deps.findOriginLaunch(origin);
  if (!origLaunch) return { status: "skipped", reason: "起点Issueの起動記録が無く、起動先のホストを決められません" };
  const result = await deps.launch({ repository: request.targetRepository, issueNumber: issue.number, ...origLaunch });
  if (!result.ok) return { status: "failed", reason: result.message };
  // 付与の失敗は起動を妨げない（セッション側の起動スクリプトも付ける。ラベルが遅れる方が軽い）
  try {
    await deps.markLocal(request.targetRepository, issue.number);
    return { status: "launched", ...origLaunch };
  } catch (error) {
    console.error("[cross-repo-filing] 11.localを付けられませんでした", error);
    return { status: "launched", ...origLaunch, labelWarning: "11.localを付けられませんでした" };
  }
}

const inFlight = new Map<string, Promise<CrossRepoFilingResult>>();

async function fileOne(request: CrossRepoIssueRequest, origin: CrossRepoOrigin, deps: CrossRepoDeps): Promise<CrossRepoFilingResult> {
  if (!(await deps.isRegistered(request.targetRepository))) {
    throw new Error(`${request.targetRepository}はissue-deckへ登録されていないため起票できません`);
  }
  const marker = crossRepoKeyMarker(origin, request.key);
  let issue = await deps.findIssueByMarker(request.targetRepository, marker);
  let outcome: "created" | "reused" = "reused";
  if (!issue) {
    issue = await deps.createIssue(request.targetRepository, { title: request.title, body: renderChildBody(request, origin) });
    outcome = "created";
  }

  // 起点のサブIssueへの紐付けは完了条件。失敗は成功扱いにせず例外にする。
  const linked = await deps.listSubIssueIds(origin);
  if (!linked.includes(issue.id)) {
    try {
      await deps.addSubIssue(origin, issue.id);
    } catch (error) {
      throw new Error(
        `${request.targetRepository}#${issue.number}を${origin.repository}#${origin.issueNumber}のサブIssueへ紐付けできません: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 起動の失敗は起票の失敗にしない（起票と紐付けは済んでおり、人が画面から起動し直せる）。
  let launch: CrossRepoLaunchOutcome;
  try {
    launch = await launchChild(request, issue, origin, deps);
  } catch (error) {
    launch = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  return { key: request.key, repository: request.targetRepository, number: issue.number, url: issue.url, outcome, launch };
}

/** 同一キーの同時実行を1つにまとめる（同じプロセス内。別プロセスの再送はマーカーで収束する） */
function fileOnce(request: CrossRepoIssueRequest, origin: CrossRepoOrigin, deps: CrossRepoDeps): Promise<CrossRepoFilingResult> {
  const id = `${origin.repository}#${origin.issueNumber}:${request.key}`;
  const running = inFlight.get(id);
  if (running) return running;
  const promise = fileOne(request, origin, deps).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

/**
 * 依頼を順に処理し、起点Issueへ結果をコメントする。**起票・紐付けが1件でも失敗したら例外**にする
 * （それまでに起票した分は次の再送でマーカーから再利用されるため、重複しない）。
 */
export async function fileCrossRepoIssues(
  requests: CrossRepoIssueRequest[],
  origin: CrossRepoOrigin,
  deps: CrossRepoDeps,
): Promise<CrossRepoFilingResult[]> {
  const results: CrossRepoFilingResult[] = [];
  for (const request of requests) results.push(await fileOnce(request, origin, deps));
  try {
    await deps.comment(origin, renderOriginComment(origin, results));
  } catch (error) {
    console.error("[cross-repo-filing] 起点Issueへのコメントに失敗しました", error);
  }
  return results;
}
