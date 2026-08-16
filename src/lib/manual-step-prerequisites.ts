import { extractManualStepOrigin } from "@/lib/branch-flow";
import { resolveProgressStatus } from "@/lib/issue-progress";
import type { Issue } from "@/types/issue";
import type { IssuePullRequest } from "@/types/pull-request";

/**
 * 手作業Issue（`71.manual-step`）が待っている相手（先に完了している必要があるIssue・PR）を
 * 本文から拾い、いまどこまで進んだかを解決する（#1705）。
 *
 * 手作業Issueのテンプレート（CLAUDE.md「ユーザーの手作業が残る場合は新規Issueとして起票する」）は
 * `## 前提条件`に「先に完了している必要があるIssue・PR」を、`## 関連`に起点Issueを書く決まりに
 * なっている。**書いてはあるが、それが今どうなっているかは書いた時点の話**で、実行する人は
 * 番号を1つずつ開いて「developには入ったのか」「本番へ出たのか」を確かめるしかなかった。
 *
 * 判定の材料は画面がすでに持っているIssueのキャッシュ（Project Statusの進捗）で、
 * **Issueの参照を解決するのにGitHub APIを1回も使わない**。Issueとして見つからなかった番号だけを
 * PRの可能性として呼び出し側が引く（`hooks/use-manual-step-prerequisites.ts`）。
 *
 * **状態を取れなかった参照は「待ち」に数えない。** 別リポジトリ・取得範囲外というだけで
 * 実行できる手作業を止めてしまわないため。左メニューの「ユーザーの作業待ち」の数え方
 * （`manual-step-attention.ts`）と同じ向きに倒している。
 */

/** 本文から拾った参照1件 */
export type ManualStepReference = {
  /**
   * 参照先のリポジトリ。`owner/repo#123`形式で書かれていればそのリポジトリ、
   * 単なる`#123`なら手作業Issue自身のリポジトリ。
   */
  repositoryFullName: string;
  number: number;
  /** `## 関連`に書かれた起点Issueか（画面では「起点」と添える） */
  origin: boolean;
};

/**
 * 参照先がどこまで進んだか。
 *
 * Issueは進捗（Project Status）で3段階（実装 → develop → main）に丸め、PRは
 * **マージ先を持っていないため段階に載せない**（`IssuePullRequest`にbaseブランチは無く、
 * マージ済みPRがdevelopまでなのかmainまで届いたのかはPR単体からは言えない）。
 */
export type ManualStepPrerequisiteStage =
  /** Issue: 進捗がDone＝mainへ反映済み */
  | "done-main"
  /** Issue: 進捗がDevelop・Release＝developへは入ったが本番未反映 */
  | "develop"
  /** Issue: 実装中（Planning〜Develop PR） */
  | "in-progress"
  /** Issue: 未着手 */
  | "not-started"
  /** Issue・PR: クローズ済み（PRは未マージのまま終わったもの） */
  | "closed"
  /** PR: マージ済み */
  | "merged"
  /** PR: マージ待ち */
  | "open"
  /** キャッシュにも取得結果にも無く、状態が分からない */
  | "unknown";

export type ManualStepPrerequisite = ManualStepReference & {
  kind: "issue" | "pull-request" | "unknown";
  /** 分かっていればタイトル。分からなければnull（番号だけ出す） */
  title: string | null;
  htmlUrl: string | null;
  stage: ManualStepPrerequisiteStage;
  /** 画面に出す状態の短い日本語 */
  label: string;
  /**
   * 手作業の実行を妨げないか。`unknown`とクローズ済みは**妨げない側**に倒す
   * （もう進みようが無い参照で手作業を止めても、待つ先が無い）。
   */
  satisfied: boolean;
  /**
   * 3段階（実装 → develop → main）のうち現在地。段階に載らないもの（PR・クローズ済み・
   * 状態不明）はnullで、画面はドットを出さない。
   */
  stepIndex: 0 | 1 | 2 | null;
};

export type ManualStepPrerequisiteSummary = {
  total: number;
  /** 実行を妨げない状態まで進んだ件数 */
  satisfiedCount: number;
  /** まだ待っている参照 */
  blocking: ManualStepPrerequisite[];
  /** 先頭に出す1行。待つ相手がいなければ実行できる旨 */
  message: string;
};

/** `owner/repo#123`または`#123` */
const REFERENCE_PATTERN = /(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+))?#(\d+)/g;
const PREREQUISITE_HEADING_PATTERN = /^#{2,3}\s*前提条件\s*$/;
const HEADING_PATTERN = /^#{2,3}\s/;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

/**
 * 本文の`## 前提条件`と`## 関連`から参照を拾う。
 *
 * `## 前提条件`の中は行を選ばずに`#番号`を拾う。テンプレートは「先に完了している必要がある
 * Issue・PR」の行にだけ番号を書くが、書式は人が書き足すため揺れる。**前提条件の節に書かれた
 * 番号は待つ相手**と読んで差し支えなく、行の見出しに依存させると拾い漏れる方が痛い。
 * コードブロックの中（コピペ用のコマンド）は拾わない。
 *
 * @param body 手作業Issueの本文
 * @param repositoryFullName 手作業Issue自身のリポジトリ。`#123`形式の参照先になる
 * @param selfNumber 手作業Issue自身の番号。自分への参照は除く
 */
export function extractManualStepReferences(
  body: string | null,
  repositoryFullName: string,
  selfNumber: number,
): ManualStepReference[] {
  const references: ManualStepReference[] = [];
  const seen = new Set<string>();

  function add(reference: ManualStepReference) {
    if (reference.repositoryFullName === repositoryFullName && reference.number === selfNumber) {
      return;
    }
    const key = `${reference.repositoryFullName}#${reference.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  }

  for (const line of prerequisiteSectionLines(body)) {
    for (const match of line.matchAll(REFERENCE_PATTERN)) {
      add({
        repositoryFullName: match[1] ?? repositoryFullName,
        number: Number(match[2]),
        origin: false,
      });
    }
  }

  // 起点Issue（`## 関連`）も待つ相手として扱う。多くの手作業は起点の変更が本番へ出た後で
  // なければ実行できない（`manual-step-attention.ts`）
  const originNumber = extractManualStepOrigin(body);
  if (originNumber !== null) {
    const key = `${repositoryFullName}#${originNumber}`;
    const existing = references.find(
      (reference) => `${reference.repositoryFullName}#${reference.number}` === key,
    );
    if (existing) {
      existing.origin = true;
    } else {
      add({ repositoryFullName, number: originNumber, origin: true });
    }
  }

  return references;
}

/** `## 前提条件`の節の行（コードフェンスの中を除く） */
function prerequisiteSectionLines(body: string | null): string[] {
  if (!body) return [];
  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) => PREREQUISITE_HEADING_PATTERN.test(line.trim()));
  if (headingIndex === -1) return [];

  const rest = lines.slice(headingIndex + 1);
  const nextHeading = rest.findIndex((line) => HEADING_PATTERN.test(line));
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const result: string[] = [];
  let openFence: string | null = null;
  for (const line of section) {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) openFence = marker;
      else if (marker === openFence) openFence = null;
      continue;
    }
    if (openFence !== null) continue;
    result.push(line);
  }
  return result;
}

/**
 * 参照をIssueキャッシュ・取得したPRと突き合わせて状態を解決する。
 *
 * @param references `extractManualStepReferences`の結果
 * @param issues 画面が持っているIssue一覧（open/closedとも）。リポジトリを跨いだ参照もここから引く
 * @param pullRequests Issueとして見つからなかった番号をPRとして引いた結果。手作業Issue自身の
 *   リポジトリのぶんだけを渡す
 * @param repositoryFullName 手作業Issue自身のリポジトリ
 */
export function resolveManualStepPrerequisites(
  references: ManualStepReference[],
  issues: Issue[],
  pullRequests: IssuePullRequest[],
  repositoryFullName: string,
): ManualStepPrerequisite[] {
  const issueByKey = new Map<string, Issue>();
  for (const issue of issues) {
    issueByKey.set(`${issue.repositoryFullName}#${issue.number}`, issue);
  }
  const pullRequestByNumber = new Map<number, IssuePullRequest>();
  for (const pullRequest of pullRequests) {
    pullRequestByNumber.set(pullRequest.number, pullRequest);
  }

  return references.map((reference) => {
    const issue = issueByKey.get(`${reference.repositoryFullName}#${reference.number}`);
    if (issue) return fromIssue(reference, issue);

    const pullRequest =
      reference.repositoryFullName === repositoryFullName
        ? pullRequestByNumber.get(reference.number)
        : undefined;
    if (pullRequest) return fromPullRequest(reference, pullRequest);

    return {
      ...reference,
      kind: "unknown",
      title: null,
      htmlUrl: null,
      stage: "unknown",
      label: "状態を取得できませんでした",
      satisfied: true,
      stepIndex: null,
    };
  });
}

function fromIssue(reference: ManualStepReference, issue: Issue): ManualStepPrerequisite {
  const base = {
    ...reference,
    kind: "issue" as const,
    title: issue.title,
    htmlUrl: issue.htmlUrl,
  };
  const status = resolveProgressStatus(issue);

  // Doneはmainへマージ完了（CLAUDE.md「Issueの進捗の状態遷移」）。closeより先に判定するのは、
  // Doneに達したIssueはcloseされるため——closedを先に見ると全部「クローズ済み」になる
  if (status === "done") {
    return { ...base, stage: "done-main", label: "mainへ反映済み", satisfied: true, stepIndex: 2 };
  }
  if (issue.state === "closed") {
    // Doneまで行かずに閉じられたIssue。もう進まないので待っても仕方がない
    return { ...base, stage: "closed", label: "クローズ済み", satisfied: true, stepIndex: null };
  }
  if (status === "develop" || status === "release") {
    return {
      ...base,
      stage: "develop",
      label: "developへマージ済み・本番未反映",
      satisfied: false,
      stepIndex: 1,
    };
  }
  if (status === "ready") {
    return { ...base, stage: "not-started", label: "未着手", satisfied: false, stepIndex: 0 };
  }
  return { ...base, stage: "in-progress", label: "実装中", satisfied: false, stepIndex: 0 };
}

function fromPullRequest(
  reference: ManualStepReference,
  pullRequest: IssuePullRequest,
): ManualStepPrerequisite {
  const base = {
    ...reference,
    kind: "pull-request" as const,
    title: pullRequest.title,
    htmlUrl: pullRequest.htmlUrl,
    // PRはマージ先を持っていないため、実装→develop→mainの段階には載せない
    stepIndex: null,
  };
  if (pullRequest.merged) {
    return { ...base, stage: "merged", label: "マージ済み", satisfied: true };
  }
  if (pullRequest.state === "closed") {
    return {
      ...base,
      stage: "closed",
      label: "未マージのままクローズ",
      satisfied: true,
    };
  }
  return { ...base, stage: "open", label: "マージ待ち", satisfied: false };
}

/** 参照の表示名（`#123`。別リポジトリなら`owner/repo#123`） */
export function formatManualStepReference(
  reference: ManualStepReference,
  repositoryFullName: string,
): string {
  const prefix =
    reference.repositoryFullName === repositoryFullName ? "" : reference.repositoryFullName;
  return `${prefix}#${reference.number}`;
}

/**
 * 先頭に出す1行を組み立てる。**待っている相手が何をするのを待っているのかまで書く**
 * （「まだ実行できません」だけでは、番号を開き直すことになって元の状態と変わらない）。
 */
export function summarizeManualStepPrerequisites(
  prerequisites: ManualStepPrerequisite[],
  repositoryFullName: string,
): ManualStepPrerequisiteSummary {
  const blocking = prerequisites.filter((prerequisite) => !prerequisite.satisfied);
  const satisfiedCount = prerequisites.length - blocking.length;

  if (blocking.length === 0) {
    return {
      total: prerequisites.length,
      satisfiedCount,
      blocking,
      message: "前提はすべて満たされています。いま実行できます。",
    };
  }

  const head = blocking[0];
  const reference = formatManualStepReference(head, repositoryFullName);
  const rest = blocking.length > 1 ? `（ほか${blocking.length - 1}件）` : "";
  return {
    total: prerequisites.length,
    satisfiedCount,
    blocking,
    message: `まだ実行できません。${reference} ${waitingFor(head)}のを待ってください${rest}。`,
  };
}

function waitingFor(prerequisite: ManualStepPrerequisite): string {
  switch (prerequisite.stage) {
    case "develop":
      return "がmainへ反映される";
    case "open":
      return "がマージされる";
    default:
      return "が完了してmainへ反映される";
  }
}
