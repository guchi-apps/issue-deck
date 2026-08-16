import { MAIN_BRANCH, releaseVersionFromTitle, resolveDeployState } from "@/lib/branch-flow";
import type { BranchFlowDeployRun } from "@/types/branch-flow";
import type { PullRequestDeployStatus } from "@/types/pull-request";

/**
 * mainへマージ済みのPR1件ぶんの材料（#1814）。
 *
 * 「そのPRを運んだリリース」を決めるのに要るのはこの3つだけ。`GET /repos/.../pulls?base=main`
 * のレスポンスから作る（`src/app/api/pull-requests/deploy-status/route.ts`）。
 */
export type MainMergedPullRequest = {
  number: number;
  title: string;
  /** mainへマージされた時刻（ISO8601） */
  mergedAt: string;
};

/** 判定の対象になるPR。一覧・詳細の`PullRequestSummary`からも、APIのレスポンスからも作れる形にする */
export type DeployTargetPullRequest = {
  number: number;
  title: string;
  baseRef: string;
  merged: boolean;
  /** マージされた時刻（ISO8601）。未マージならnull */
  mergedAt: string | null;
};

/**
 * PR1件が本番（main）へ届いたかを判定する（#1814）。
 *
 * **材料も判定もブランチ画面（#1455・#1579）と同じ**にしている。あちらは「どの版に何が乗ったか」を
 * リポジトリ単位で組み立てるが、PR詳細が要るのは開いている1本ぶんだけなので、同じ計算を
 * PR1件へ適用できる形で切り出した。デプロイの成否は`resolveDeployState`をそのまま通すので、
 * 2つの画面で結論がずれない。
 *
 * 前提は**「作業PRがdevelopへ入った後、最初にmainへマージされたPRがその変更を運んだ」**こと
 * （リリースPRはマージ時点のdevelopの先端を運ぶため）。この前提から外れるもの——`releases`の
 * 範囲より古いPR——は「判定できない」として`null`を返す。
 *
 * **判定できないときに「未反映」と言わない。** 間違った状態を出すより何も言わない方がよい、
 * というブランチ画面の方針をそのまま引き継いでいる。
 */
export function resolvePullRequestDeployStatus({
  pullRequest,
  releases,
  deployRun,
  now,
}: {
  pullRequest: DeployTargetPullRequest;
  /** mainへマージ済みのPR。順序は問わない（この関数で古い順に並べ直す） */
  releases: MainMergedPullRequest[];
  /** mainブランチの`deploy.yml`の最新実行。取得できなければnull */
  deployRun: BranchFlowDeployRun | null;
  now: number;
}): PullRequestDeployStatus | null {
  if (!pullRequest.merged || pullRequest.mergedAt === null) return null;

  const sorted = [...releases].sort(
    (a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime(),
  );

  // mainをbaseとするPR（リリースPR自身・main直マージ）は、自分のマージがそのままmain到達になる。
  const carrier =
    pullRequest.baseRef === MAIN_BRANCH
      ? { number: pullRequest.number, title: pullRequest.title, mergedAt: pullRequest.mergedAt }
      : findCarrier(sorted, pullRequest.mergedAt);

  if (carrier === null) {
    // mainへのマージを1件も取れていない場合は、developで止まっているのか、取得範囲より
    // 古いだけなのかを区別できない。
    if (sorted.length === 0) return null;
    return {
      kind: "develop-only",
      version: null,
      releasePullRequestNumber: null,
      deployRunUrl: null,
    };
  }

  const version = releaseVersionFromTitle(carrier.title);
  const latest = sorted[sorted.length - 1];

  // 運び手より後のリリースが既にmainへ入っている場合、この変更はその時点の本番に含まれている。
  // `deploy.yml`の最新実行が言えるのはいちばん新しい版についてだけなので、そこは見ない。
  if (latest !== undefined && new Date(latest.mergedAt).getTime() > new Date(carrier.mergedAt).getTime()) {
    return {
      kind: "deployed",
      version,
      releasePullRequestNumber: carrier.number,
      deployRunUrl: null,
    };
  }

  const state = resolveDeployState({ deployRun, releaseMergedAt: carrier.mergedAt, now });
  if (state === null) return null;

  return {
    kind:
      state.kind === "success"
        ? "deployed"
        : state.kind === "failure"
          ? "failed"
          : state.kind === "running"
            ? "running"
            : "waiting",
    version,
    releasePullRequestNumber: carrier.number,
    deployRunUrl: state.htmlUrl,
  };
}

/** マージ時刻より後に、最初にmainへ入ったPR（＝その変更を運んだリリース）を探す */
function findCarrier(
  sortedReleases: MainMergedPullRequest[],
  mergedAtIso: string,
): MainMergedPullRequest | null {
  const mergedAt = new Date(mergedAtIso).getTime();
  return (
    sortedReleases.find((release) => new Date(release.mergedAt).getTime() > mergedAt) ?? null
  );
}

/**
 * まだ本番へ出ておらず、追いかける意味がある状態か（#1814）。
 * デプロイ状況の取り直し（`hooks/use-pull-request-deploy-status.ts`）を続けるかの判断に使う。
 */
export function isPendingPullRequestDeployStatus(status: PullRequestDeployStatus | null): boolean {
  return status !== null && (status.kind === "waiting" || status.kind === "running");
}
