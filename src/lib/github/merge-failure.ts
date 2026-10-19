/**
 * GitHubがPRのマージ（`PUT /pulls/{n}/merge`）を拒んだ理由を、画面に出せる日本語へ読み直す（#4878）。
 *
 * 以前は`GitHub API request failed: 405 https://api.github.com/... {"message":...}`をそのまま
 * 画面に出しており、1行に切り詰められて「なぜマージできないのか」が読めなかった。
 *
 * **GitHubの文言は固定ではない**（ブランチ保護とルールセットで言い回しが違い、ルールセットは
 * `Repository rule violations found`の後に違反を並べる）。分類は部分一致で行い、どれにも
 * 当たらなければ原文の要点（URLを除いた`message`）を出す側へ倒す。
 */

export type MergeFailureKind =
  | "required_check"
  | "review_required"
  | "merge_method_not_allowed"
  | "not_mergeable"
  | "base_modified"
  | "draft"
  | "head_modified"
  | "already_closed"
  | "forbidden"
  | "rule_violation"
  | "unknown";

/** 必須チェック1件の、いまの状態（取れたときだけ） */
export type MergeFailureCheckState = {
  /** `success` | `pending` | `failure` | `missing`（そのコミットにまだ付いていない） */
  state: "success" | "pending" | "failure" | "missing";
  /** commit statusのdescription。check-runや未取得ならnull */
  description: string | null;
};

export type MergeFailure = {
  kind: MergeFailureKind;
  /** GitHubが返したHTTPステータス */
  httpStatus: number;
  /** 1行の見出し。一覧の行など狭い場所ではこれだけを出す */
  title: string;
  /** なぜそうなっているか。無ければnull */
  reason: string | null;
  /** 次にすること・この後どうなるか。無ければnull */
  next: string | null;
  /** 原因の必須チェック名。必須チェック以外はnull */
  checkName: string | null;
  /** 原因の必須チェックの状態。取れなければnull */
  check: MergeFailureCheckState | null;
  /** GitHubの原文（URLを除いた`message`）。折りたたみに出す */
  githubMessage: string | null;
};

/** マージを拒まれたときに理由を読み直すHTTPステータス。それ以外（401・5xxなど）は従来の扱いのまま */
export const MERGE_REJECTION_STATUSES = new Set([403, 405, 409, 422]);

export type MergeFailurePullRequest = {
  state?: string;
  merged?: boolean;
  draft?: boolean;
  /** Auto-mergeが有効か */
  autoMerge?: boolean;
  /** マージ先のブランチ名 */
  baseRef?: string;
};

export type DescribeMergeFailureInput = {
  status: number;
  /** GitHubの応答本文（生の文字列） */
  body: string | null | undefined;
  pullRequest?: MergeFailurePullRequest;
  /** 原因の必須チェックの状態。`requiredCheckNameOf`で名前が取れたときに呼び出し側が引いて渡す */
  check?: MergeFailureCheckState | null;
};

/** 本文から`message`を取り出す。JSONでなければ本文そのもの（長すぎれば切る） */
export function githubMessageOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return (parsed as { message: string }).message.trim() || null;
    }
  } catch {
    // JSONでない応答はそのまま使う
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

const REQUIRED_CHECK_PATTERN = /Required status check "([^"]+)"/i;

/** 原因が必須チェックなら、その名前。名前の無い言い回し（`2 of 3 required status checks ...`）ではnull */
export function requiredCheckNameOf(body: string | null | undefined): string | null {
  const message = githubMessageOf(body);
  return message?.match(REQUIRED_CHECK_PATTERN)?.[1] ?? null;
}

function isRequiredCheckMessage(message: string): boolean {
  return REQUIRED_CHECK_PATTERN.test(message) || /required status checks? (?:is|are)/i.test(message);
}

/** ルールセットの違反行（見出しの後に並ぶ1行ずつ）。見出しだけなら空 */
function ruleViolationLines(message: string): string[] {
  return message
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Repository rule violations found/i.test(line));
}

function checkStateLabel(state: MergeFailureCheckState["state"]): string {
  switch (state) {
    case "success":
      return "成功";
    case "pending":
      return "待機中";
    case "failure":
      return "失敗";
    case "missing":
      return "未実行";
  }
}

/** 必須チェックの状態を1行の説明にする（画面の「いまの状態」） */
export function describeCheckState(check: MergeFailureCheckState): string {
  const label = checkStateLabel(check.state);
  return check.description ? `${label}: ${check.description}` : label;
}

export function describeMergeFailure(input: DescribeMergeFailureInput): MergeFailure {
  const { status, pullRequest } = input;
  const githubMessage = githubMessageOf(input.body);
  const message = githubMessage ?? "";
  const base = {
    httpStatus: status,
    githubMessage,
    checkName: null,
    check: null,
  } satisfies Partial<MergeFailure>;
  const branch = pullRequest?.baseRef ? `「${pullRequest.baseRef}」` : "マージ先のブランチ";

  // PRがもう開いていないなら、他の理由より先にそれを言う（2回目の押下・別経路で先にマージ済み）
  if (pullRequest?.merged || pullRequest?.state === "closed") {
    return {
      ...base,
      kind: "already_closed",
      title: pullRequest.merged ? "このPRはすでにマージされています" : "このPRはクローズされています",
      reason: null,
      next: "画面を更新してください。",
    };
  }

  if (status === 403) {
    return {
      ...base,
      kind: "forbidden",
      title: "issue-deckにこのPRをマージする権限がありません",
      reason: "GitHubがissue-deckのGitHub Appからのマージを拒否しました。",
      next: "GitHub Appの権限（Contents・Pull requestsの書き込み）と、ブランチ保護の許可対象を確認してください。",
    };
  }

  if (status === 409 || /Head branch was modified/i.test(message)) {
    return {
      ...base,
      kind: "head_modified",
      title: "確認した後に、PRへ新しいコミットが積まれました",
      reason: "マージしようとした時点のコミットが、PRの最新のコミットと一致しませんでした。",
      next: "画面を更新して、最新の内容で確認し直してください。",
    };
  }

  if (/draft/i.test(message) || pullRequest?.draft) {
    return {
      ...base,
      kind: "draft",
      title: "ドラフトのPRはマージできません",
      reason: null,
      next: "GitHubでReady for reviewにしてからマージしてください。",
    };
  }

  if (isRequiredCheckMessage(message)) {
    const checkName = requiredCheckNameOf(input.body);
    const check = checkName ? (input.check ?? null) : null;
    const autoMergeNext =
      pullRequest?.autoMerge && check?.state !== "failure"
        ? "Auto-mergeが有効なので、チェックが成功すれば自動でマージされます。"
        : null;
    return {
      ...base,
      kind: "required_check",
      title: "必須チェックがまだ成功していないため、マージできません",
      reason: checkName
        ? `${branch}のルールで、チェック「${checkName}」の成功がマージの条件になっています。`
        : `${branch}のルールで必須になっているチェックが、まだ成功していません。`,
      next:
        autoMergeNext ??
        (check?.state === "failure"
          ? "チェックの失敗を直してから、もう一度マージしてください。"
          : "チェックが成功してから、もう一度マージしてください。"),
      checkName,
      check,
    };
  }

  const reviewMatch = message.match(/At least (\d+) approving reviews? (?:is|are) required/i);
  if (reviewMatch || /review is required|Waiting on code owner review|Changes requested/i.test(message)) {
    return {
      ...base,
      kind: "review_required",
      title: reviewMatch ? `承認レビューがあと${reviewMatch[1]}件必要です` : "必要なレビューの承認が揃っていません",
      reason: `${branch}のルールで、マージ前の承認レビューが必須になっています。`,
      next: "GitHubでレビューの承認を得てから、もう一度マージしてください。",
    };
  }

  if (/Merge commits are not allowed/i.test(message)) {
    return {
      ...base,
      kind: "merge_method_not_allowed",
      title: "このリポジトリではマージコミットでのマージが禁止されています",
      reason: "issue-deckはマージコミットでマージします。リポジトリの設定かルールで、この方法が許可されていません。",
      next: "リポジトリ設定の「Allow merge commits」と、ルールセットのマージ方法の制限を確認してください。",
    };
  }

  if (/Base branch was modified/i.test(message)) {
    return {
      ...base,
      kind: "base_modified",
      title: "マージ先のブランチが直前に更新されました",
      reason: null,
      next: "数秒待ってから、もう一度押してください。",
    };
  }

  if (/Repository rule violations found/i.test(message)) {
    const lines = ruleViolationLines(message);
    return {
      ...base,
      kind: "rule_violation",
      title: "リポジトリのルールに違反しているため、マージできません",
      reason: lines.length > 0 ? lines.join(" / ") : null,
      next: "GitHubのルールセットの設定を確認してください。",
    };
  }

  if (/not mergeable/i.test(message)) {
    return {
      ...base,
      kind: "not_mergeable",
      title: "GitHubがまだマージできない状態と判定しています",
      reason: "コンフリクト・必須チェック・ブランチ保護のいずれかが満たされていません。",
      next: "少し待って画面を更新してください。変わらなければGitHubのPR画面で原因を確認してください。",
    };
  }

  return {
    ...base,
    kind: "unknown",
    title: `GitHubがマージを受け付けませんでした（HTTP ${status}）`,
    reason: githubMessage,
    next: null,
  };
}
