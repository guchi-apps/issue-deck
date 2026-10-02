import {
  decideDeployFailure,
  type DeployFailureDecision,
  type DeployFailureSweepRun,
  type DeployFailureTrackedIssue,
} from "@/lib/deploy-failure";

/**
 * iOS配布（`ios-testflight.yml`）が失敗したまま止まっているリポジトリを巡回で見つけ、
 * 追跡用のIssueを自動で起票する（#3745）。
 *
 * Webの本番デプロイ失敗（#2236。`deploy-failure.ts`）と**同じ判定・同じ巡回の形**で、
 * 起票してよいかの判定は`decideDeployFailure`をそのまま使う（猶予・成功時のクローズ・
 * 「別のrunが落ちたら書き足す」の取り決めが同じため）。違うのは対象のworkflowと、
 * 本文に失敗した**段階**（署名・ビルドなど）を書く点だけ。
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

export function decideIosDistributionFailure(input: {
  run: DeployFailureSweepRun | null;
  tracked: DeployFailureTrackedIssue | null;
  now: Date;
  graceMinutes?: number;
}): DeployFailureDecision {
  return decideDeployFailure({
    ...input,
    graceMinutes: input.graceMinutes ?? iosDistributionFailureGraceMinutes(),
  });
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
