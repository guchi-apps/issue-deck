/**
 * iOS配布（`ios-testflight.yml`）が失敗したまま止まっているリポジトリを巡回で見つけ、
 * 追跡用のIssueを自動で起票する（#3745）。
 *
 * 失敗から猶予を置き、成功時は追跡Issueを閉じ、別のrunの失敗は既存Issueへ書き足す。
 * 本文には失敗した**段階**（署名・ビルドなど）を書く。
 *
 * **起票のみで、実装の自動起動はしない。** 署名の期限切れ・Apple側の一時障害のように
 * コードでは直らない失敗が多く、失敗の型を溜めてから自動化の線を引く方が安全なため。
 * Issueからは従来どおり人が「実装を開始」できる。
 */

/** Issueのタイトルの頭に付ける印。Webのデプロイ失敗（`[デプロイ失敗]`）と見分ける */
export const IOS_DISTRIBUTION_FAILURE_TITLE_PREFIX = "[iOS配布失敗]";

const META_MARKER_PREFIX = "<!-- ios-distribution-failure:";

const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
/** 失敗を見てから起票するまでの既定の猶予（分）。手動の出し直しで直る時間を待つ */
const DEFAULT_GRACE_MINUTES = 10;

function nonNegativeMinutes(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 巡回の間隔（分）。0以下は「巡回しない」 */
export function iosDistributionFailureSweepIntervalMinutes(
  raw: string | undefined = process.env.IOS_DISTRIBUTION_FAILURE_SWEEP_INTERVAL_MINUTES,
): number {
  return nonNegativeMinutes(raw, DEFAULT_SWEEP_INTERVAL_MINUTES);
}

export function iosDistributionFailureGraceMinutes(
  raw: string | undefined = process.env.IOS_DISTRIBUTION_FAILURE_ISSUE_GRACE_MINUTES,
): number {
  return nonNegativeMinutes(raw, DEFAULT_GRACE_MINUTES);
}

type IosDistributionFailureSweepRun = {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  updatedAt: string;
  runAttempt: number;
};

type IosDistributionFailureTrackedIssue = { issueNumber: number; runId: number };

export type IosDistributionFailureSkipReason =
  | "no_run"
  | "not_completed"
  | "not_failed"
  | "within_grace"
  | "already_tracked";

export type IosDistributionFailureDecision =
  | { kind: "create" }
  | { kind: "update"; issueNumber: number }
  | { kind: "close"; issueNumber: number }
  | { kind: "skip"; reason: IosDistributionFailureSkipReason };

export function decideIosDistributionFailure(input: {
  run: IosDistributionFailureSweepRun | null;
  tracked: IosDistributionFailureTrackedIssue | null;
  now: Date;
  graceMinutes?: number;
}): IosDistributionFailureDecision {
  const { run, tracked, now, graceMinutes = iosDistributionFailureGraceMinutes() } = input;
  if (run === null) return { kind: "skip", reason: "no_run" };
  if (run.status !== "completed") return { kind: "skip", reason: "not_completed" };
  const failed = run.conclusion === "failure" || run.conclusion === "timed_out";
  if (!failed) {
    if (tracked !== null && run.conclusion === "success") {
      return { kind: "close", issueNumber: tracked.issueNumber };
    }
    return { kind: "skip", reason: "not_failed" };
  }
  if (tracked !== null && tracked.runId === run.id) return { kind: "skip", reason: "already_tracked" };
  const elapsedMs = now.getTime() - new Date(run.updatedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < graceMinutes * 60_000) {
    return { kind: "skip", reason: "within_grace" };
  }
  return tracked === null ? { kind: "create" } : { kind: "update", issueNumber: tracked.issueNumber };
}

export type IosDistributionFailureMeta = {
  repositoryFullName: string;
  /** 失敗した`ios-testflight.yml`のrun id */
  runId: number;
  runUrl: string;
  /** 失敗した段階の表示名。名前から推定できなければnull */
  failedStage: string | null;
  /** 失敗したジョブ名。取れなければ空配列 */
  failedJobs: string[];
  /** 失敗を検知した時刻（ISO8601） */
  detectedAt: string;
};

export function buildIosDistributionFailureIssueTitle(meta: IosDistributionFailureMeta): string {
  const stage = meta.failedStage ? `（${meta.failedStage}）` : "";
  return `${IOS_DISTRIBUTION_FAILURE_TITLE_PREFIX} ${meta.repositoryFullName}: iOSのTestFlight配布が失敗しました${stage}`;
}

function detailLines(meta: IosDistributionFailureMeta): string {
  const stage = meta.failedStage ? `\n- 失敗した段階: ${meta.failedStage}（ジョブ・ステップ名からの推定）` : "";
  const jobs =
    meta.failedJobs.length > 0 ? `\n- 失敗したジョブ: \`${meta.failedJobs.join("`, `")}\`` : "";
  return `- 失敗した実行: ${meta.runUrl}${stage}${jobs}\n- 検知: ${meta.detectedAt}`;
}

/** 先頭に不可視のマーカーを置く。Webのデプロイ失敗のマーカーとは別名にして取り違えを防ぐ */
export function buildIosDistributionFailureIssueBody(meta: IosDistributionFailureMeta): string {
  return `${META_MARKER_PREFIX} ${JSON.stringify(meta)} -->

## 何が起きているか

${meta.repositoryFullName}のiOS配布（\`ios-testflight.yml\`）が失敗しました。
**Webの本番デプロイとは別の経路で、TestFlightへ新しいビルドが届いていません。**

${detailLines(meta)}

## どうすれば直るか

- ネットワーク・Apple側の一時障害のような失敗なら、**もう一度流し直すだけで直ります。**
  issue-deckの「ブランチとPRの流れ」画面にあるリリース束の「iOS配布」欄の「iOSへ配布」を押してください
- 署名（証明書・プロビジョニングプロファイルの期限切れ）やApple Developerの規約同意待ちが原因なら、
  コードではなくアカウント側の対応が要ります。実行ログを確認してください
- 同じところで落ち続け、コードや設定の修正が要る場合は、このIssueからそのまま実装を開始できます

## 補足

- このIssueはissue-deckが自動で起票しています。**後続のiOS配布が成功した時点で自動でクローズされます。**
- 同じリポジトリで同時に開くのは1件だけです。直らないまま別の実行も失敗した場合は、新しく立てずにこのIssueへ書き足します
`;
}

export function buildIosDistributionFailureUpdateComment(meta: IosDistributionFailureMeta): string {
  return `⚠️ **iOS配布がもう一度失敗しました。**

${detailLines(meta)}

このIssueが指している失敗を、いちばん新しいものへ更新しました。
`;
}

export function buildIosDistributionFailureResolvedComment(runUrl: string): string {
  return `✅ **iOS配布が成功しました。** 自動でクローズします。

- 成功した実行: ${runUrl}
`;
}

/** Issue本文からマーカーを読む。iOS配布失敗Issueでなければnull。壊れた値も「無し」として扱う */
export function parseIosDistributionFailureMeta(
  body: string | null | undefined,
): IosDistributionFailureMeta | null {
  if (!body) return null;
  const start = body.indexOf(META_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf("-->", start);
  if (end === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start + META_MARKER_PREFIX.length, end).trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const meta = parsed as Record<string, unknown>;
  if (typeof meta.repositoryFullName !== "string" || typeof meta.runUrl !== "string") return null;
  return {
    repositoryFullName: meta.repositoryFullName,
    runId: typeof meta.runId === "number" ? meta.runId : 0,
    runUrl: meta.runUrl,
    failedStage: typeof meta.failedStage === "string" ? meta.failedStage : null,
    failedJobs: Array.isArray(meta.failedJobs)
      ? meta.failedJobs.filter((job): job is string => typeof job === "string")
      : [],
    detectedAt: typeof meta.detectedAt === "string" ? meta.detectedAt : "",
  };
}

export type IosDistributionFixIssueDraft = {
  repositoryFullName: string;
  title: string;
  body: string;
};

/**
 * ブランチ画面の「修正Issueを起案」（#3784）が開く新規作成ダイアログの下書き。
 *
 * **ここでは起票しない。** 巡回の自動起票（`buildIosDistributionFailureIssueBody`）とは別の、人が修正を
 * 依頼するための下書きで、**自動起票のマーカー（`<!-- ios-distribution-failure: -->`）は入れない**
 * （マーカーがあると自動起票のIssueと取り違えられる）。実際に起票したIssueは、画面が追跡Issueとして
 * 登録し、以後の二重起票・成功時のクローズを巡回に任せる。ジョブ名はAPIが返さないため入れない。
 */
export function buildIosDistributionFixIssueDraft(params: {
  repositoryFullName: string;
  version: string | null;
  sha: string;
  runUrl: string;
  failedStage: string | null;
  notes: readonly string[];
}): IosDistributionFixIssueDraft {
  const { repositoryFullName, version, sha, runUrl, failedStage, notes } = params;
  const versionLabel = version ? `v${version}の` : "";
  const stageLabel = failedStage ? `（${failedStage}）` : "";
  const lines = [
    `- 対象: ${repositoryFullName}${version ? ` v${version}` : ""}（mainコミット ${sha.slice(0, 7)}）`,
    `- 失敗した実行: ${runUrl}`,
    ...(failedStage ? [`- 失敗した段階: ${failedStage}（ジョブ・ステップ名からの推定）`] : []),
    ...notes.map((note) => `- 実行の注記: ${note}`),
  ];
  return {
    repositoryFullName,
    title: `${IOS_DISTRIBUTION_FAILURE_TITLE_PREFIX} ${repositoryFullName}: ${versionLabel}TestFlight配布の失敗を修正する${stageLabel}`,
    body: `## 何が起きているか

${repositoryFullName}のiOS配布（\`ios-testflight.yml\`）が失敗しました。Webの本番デプロイとは別の経路で、TestFlightへ新しいビルドが届いていません。

${lines.join("\n")}

## 直したいこと

実行ログを確認し、失敗の原因になっているコード・設定の修正を行ってください。
署名の期限切れやApple Developerの規約同意待ちのようにアカウント側の対応が要る場合は、その手順を手作業Issueとして切り出してください。

## 補足

- 一時的な障害なら、ブランチ画面のiOS配布欄の「再実行」で直ることがあります
- このIssueを起票すると、iOS配布の巡回はこのIssueを追跡します。後続の配布が成功すると自動でクローズされ、別の実行が失敗した場合は書き足されます
`,
  };
}
