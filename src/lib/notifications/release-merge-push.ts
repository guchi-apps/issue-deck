import { MAIN_BRANCH } from "@/lib/branch-flow";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  type CiState,
  fetchOpenPullRequestsForBase,
  fetchRefCheckState,
} from "@/lib/github/release-api";
import {
  isWaitingUserMerge,
  releaseMergeTargetLabel,
} from "@/lib/github/release-button-status";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { buildPullRequestId } from "@/lib/github-reference";
import {
  isPushConfigured,
  sendPushNotification,
  type PushNotificationPayload,
} from "@/lib/notifications/push";
import { isMergeJudgementPending, isReleaseHeadRef } from "@/lib/pull-request-list";

/**
 * 本番へのマージ待ち（develop→mainのリリースPR）のPush通知（#2376）。
 *
 * **確認待ち（`00.check-user`）と違って、待っているものがIssueに紐づかない。** リリースPRは
 * `release-main/vX.Y.Z`→`main`で、対応Issue番号を持たないため`claude-review-develop.yml`の
 * 自動マージも掛からず（[docs/multi-agent/release.md](../../../docs/multi-agent/release.md)）、
 * 人がマージするまで本番が古い版のまま止まる。それが分かるのは通知ベルとバッジだけで、
 * どちらも**ブラウザを開いていないと見えない**。**`deploy.yml`の実行履歴からも気づけない**
 * （`main`へのpushでしか走らないため、止まっている間は「直近すべて成功」に見える）。
 * #2230では止まったリリースが18時間放置され、そのあいだ`main`は`4.31.0`・`develop`は
 * `4.32.0`のままだった。
 *
 * **CIが落ちているリリースPRも通知する。** そのときは押す操作がマージではなく修正になるが、
 * 人が動かないと止まっているのは同じで、放置されていたのがまさにこの状態だった。
 * 文言だけ「チェック失敗」に変える（#1059と同じ書き分け）。
 *
 * ## 判定は画面と同じものを通す
 *
 * 「マージ待ちか」は`isWaitingUserMerge`（`github/release-button-status.ts`）に閉じている。
 * CIが走っている最中・自動マージ可否の判定中は画面も「押す番」にしない（#1433・#2326）ので、
 * ここで別の基準を作ると**画面が我慢している最中に通知だけが鳴る**。
 *
 * ## 鳴らした記録はDBに持つ
 *
 * `ReleaseMergePushNotice`（リポジトリ＋PR番号＋最後に鳴らした時刻）。**巡回の間隔と違って
 * プロセス内には置けない。** 巡回の再実行は冪等でも通知は鳴り直すもので、本番はPM2の
 * `max_memory_restart`で落ちることがある（#2331）。`public/sw.js`は`renotify: true`で出すため、
 * 同じ`tag`でも静かに置き換わらず毎回鳴る。確認待ちのPushが`Issue.checkUserPushSentAt`へ
 * 送信前に席を取っている（#2300）のと同じ役割で、置き場所だけが別の表になっている。
 */

/** 巡回の既定間隔（分）。GitHub APIを叩くので、他の巡回（5分）より長く取る */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 10;

/**
 * 同じPRを鳴らし直すまでの既定の間隔（時間）。
 *
 * **1回鳴らして終わりにしない。** 気づかれずに残るのがこの待ちの問題そのもの（#2230）で、
 * 通知ベルとバッジは開かないと見えない。一方でマージ待ちは人が動くまで消えないため、
 * 短くすると同じPRで鳴り続ける。0にすると鳴らし直さない。
 */
const DEFAULT_RENOTIFY_HOURS = 6;

/** 1回の巡回で見るリポジトリ数の上限。取りこぼしても次の巡回で拾える */
const SWEEP_REPOSITORY_LIMIT = 60;

/** 巡回の間隔（分）。環境変数が読めない・数値でない場合は既定値。0以下は「巡回しない」 */
export function releaseMergePushSweepIntervalMinutes(
  raw: string | undefined = process.env.RELEASE_MERGE_PUSH_SWEEP_INTERVAL_MINUTES,
): number {
  return nonNegativeNumber(raw, DEFAULT_SWEEP_INTERVAL_MINUTES);
}

/** 鳴らし直すまでの間隔（時間）。0にすると1つのPRにつき1回しか鳴らさない */
export function releaseMergePushRenotifyHours(
  raw: string | undefined = process.env.RELEASE_MERGE_PUSH_RENOTIFY_HOURS,
): number {
  return nonNegativeNumber(raw, DEFAULT_RENOTIFY_HOURS);
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** 巡回が見つけた、人のマージ操作を待っているリリースPR1件 */
export type PendingReleaseMerge = {
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  ciState: CiState;
};

/**
 * 通知の中身。1行目にリポジトリと状態、2行目にPRを置く。
 *
 * **文言は画面と同じ語彙**（`releaseMergeTargetLabel`）。CIが落ちているものも「押す番」では
 * あるので通知するが、そのときは「マージ待ち」と言わない——「マージすればよい」と
 * 「チェックが落ちていて直す必要がある」を取り違えさせないため（#1059）。
 *
 * タップ先は通知ベルの行と同じPR詳細（`useReferenceNavigation.openPullRequest`が組み立てる
 * URLと同じ形）。マージボタンとCI状態がそこにある。
 */
export function buildReleaseMergePushPayload(
  pending: PendingReleaseMerge,
): PushNotificationPayload {
  const repositoryName =
    pending.repositoryFullName.split("/")[1] ?? pending.repositoryFullName;
  const state =
    pending.ciState === "failure" ? "チェック失敗" : releaseMergeTargetLabel("main");
  const pullRequestId = buildPullRequestId(pending.repositoryFullName, pending.pullRequestNumber);
  return {
    title: `${repositoryName} ・ ${state}`,
    body: `#${pending.pullRequestNumber} ${pending.pullRequestTitle}`,
    // PC（`pane`・`pr`）とスマホ（`mscreen`）で現在地の持ち方が違うので両方載せる。
    // `useReferenceNavigation.openPullRequest`が画面内のリンクで組み立てるURLと同じ形
    url: `/dashboard?pane=pull-requests&pr=${encodeURIComponent(pullRequestId)}&mscreen=pull-requests`,
    tag: `release-merge:${pullRequestId}`,
  };
}

export type ReleaseMergePushResult = {
  /** 実際に巡回したか。間隔に達していない・無効化されている場合は`false` */
  swept: boolean;
  /** `RELEASE_MERGE_PUSH_SWEEP_INTERVAL_MINUTES=0`で止めているか */
  disabled: boolean;
  /** リリースworkflowを持っていて実際に見たリポジトリ数 */
  repositories: number;
  /** 人のマージ操作を待っていたリリースPR */
  pending: PendingReleaseMerge[];
  /** 実際に通知を送ったPR（鳴らし直しの間隔に達していないものは入らない） */
  notified: PendingReleaseMerge[];
  /** 状況を取得できなかったリポジトリ */
  failedRepositories: string[];
};

function emptyResult(overrides: Partial<ReleaseMergePushResult> = {}): ReleaseMergePushResult {
  return {
    swept: false,
    disabled: false,
    repositories: 0,
    pending: [],
    notified: [],
    failedRepositories: [],
    ...overrides,
  };
}

/**
 * 最後に巡回した時刻（epoch ms）。**プロセス内にしか持たない**（他の巡回と同じ）。
 * 再起動で忘れても起きるのは「1回余分に巡回する」だけで、**鳴らすかどうかはDBが決める**ので
 * 通知が増えることはない。
 */
let lastSweptAt: number | null = null;

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetReleaseMergePushSweepIntervalForTest(): void {
  lastSweptAt = null;
}

/**
 * 本番へのマージ待ちを巡回し、見つけたらPush通知する。
 *
 * **連携済みリポジトリ全部を1回の巡回で見る。** 呼ぶのはログインセッションを持たない
 * サブPCのpollerなので、ユーザー単位の絞り込み（`userInstallations`）は母集団では行わない
 * （コンフリクト巡回#2116・デプロイ失敗巡回#2236と同じ方針）。絞り込むのは宛先の側で、
 * **そのリポジトリを非表示にしているユーザーへは送らない**（#2279）。
 *
 * ## GitHub APIの消費
 *
 * 巡回1回あたり、リリースworkflowを持つリポジトリごとにREST 1回（`main`宛のopen PR一覧）。
 * リリースPRがあるときだけ、そのリポジトリでCI状態のGraphQLが1回増える。
 * `release-develop-to-main.yml`の有無はプロセス内キャッシュ（`releaseWorkflowExists`）。
 */
export async function runReleaseMergePushSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<ReleaseMergePushResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = releaseMergePushSweepIntervalMinutes();
  if (intervalMinutes <= 0) return emptyResult({ disabled: true });

  if (!options.force && lastSweptAt !== null) {
    if (now.getTime() - lastSweptAt < intervalMinutes * 60_000) return emptyResult();
  }
  lastSweptAt = now.getTime();

  // **購読が1件も無ければGitHubを叩かない。** 送り先の無い巡回でレート制限を使わない
  // （VAPID未設定のホスト・誰もPush通知を登録していないホストがこれに当たる）。
  if (!isPushConfigured()) return emptyResult({ swept: true });
  if ((await db.pushSubscription.count()) === 0) return emptyResult({ swept: true });

  const repositories = await db.repository.findMany({
    where: { archived: false },
    orderBy: { fullName: "asc" },
    take: SWEEP_REPOSITORY_LIMIT,
    // `Repository.installationId`は内部のcuid（宛先の絞り込みに使う）。GitHubの数値の
    // インストールID（トークンの取得に使う）は`installation`側にあるので、両方引く
    select: {
      id: true,
      fullName: true,
      ownerLogin: true,
      name: true,
      installationId: true,
      installation: { select: { installationId: true } },
    },
  });

  // 同一installationのリポジトリ間でトークン取得を使い回す（`release-pending-merges`と同じ）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const result = emptyResult({ swept: true });

  for (const repository of repositories) {
    try {
      const token = await tokenFor(repository.installation.installationId);
      if (!(await releaseWorkflowExists(repository.ownerLogin, repository.name, token))) continue;
      result.repositories += 1;

      const mainBasePullRequests = await fetchOpenPullRequestsForBase(
        repository.ownerLogin,
        repository.name,
        MAIN_BRANCH,
        token,
      );
      // headは`release-main/vX.Y.Z`（#2117）。参照タグが古いリポジトリではまだ`develop`。
      const releasePr = mainBasePullRequests.find((pr) => isReleaseHeadRef(pr.head.ref)) ?? null;

      // **マージ・クローズされたPRの記録は、その場で消す。** 残しておくと、同じ番号が
      // 再利用されることは無いにせよ表が伸び続ける
      await forgetSettledNotices(repository.fullName, releasePr?.number ?? null);
      if (!releasePr) continue;

      const check = await fetchRefCheckState(
        repository.ownerLogin,
        repository.name,
        releasePr.head.ref,
        token,
      );
      const waiting = isWaitingUserMerge({
        ciState: check.ciState,
        mergeJudgementPending: isMergeJudgementPending(check.mergeJudgement),
      });
      if (!waiting) continue;

      const pending: PendingReleaseMerge = {
        repositoryFullName: repository.fullName,
        pullRequestNumber: releasePr.number,
        pullRequestTitle: releasePr.title,
        ciState: check.ciState,
      };
      result.pending.push(pending);

      // **送る前に記録を立てて席を取る**（確認待ちのPushと同じ。#2300）。取れなかったら、
      // まだ鳴らし直す間隔に達していないか、別の巡回が既に掴んでいる
      if (!(await reserveReleaseMergePush(pending, now))) continue;

      const targets = await db.pushSubscription.findMany({
        where: {
          user: {
            userInstallations: { some: { installationId: repository.installationId } },
            hiddenRepositories: { none: { repositoryId: repository.id } },
          },
        },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      if (targets.length === 0) continue;

      await sendPushNotification(targets, buildReleaseMergePushPayload(pending));
      result.notified.push(pending);
    } catch (error) {
      // 1リポジトリの取得失敗で他リポジトリの通知まで巻き込まない（`release-pending-merges`と同じ）。
      console.error(`[runReleaseMergePushSweep] ${repository.fullName}:`, error);
      result.failedRepositories.push(repository.fullName);
    }
  }

  return result;
}

/**
 * 「これから鳴らす」ことを先に記録して席を取る。取れたらtrue。
 *
 * 初回は`create`が、鳴らし直しは`updateMany`が席になる。どちらも一意キー
 * （`repositoryFullName` + `pullRequestNumber`）と`notifiedAt`の条件で確定するので、
 * 巡回が同時に何本走ってもトランザクションもロックも要らない。
 *
 * **送信の成否で記録を戻さない**（確認待ちのPushと同じ）。一時的な失敗のために巡回のたび
 * 鳴らし直すより、1件落として次の鳴らし直しに任せる方が軽い。
 */
async function reserveReleaseMergePush(
  pending: PendingReleaseMerge,
  now: Date,
): Promise<boolean> {
  const key = {
    repositoryFullName: pending.repositoryFullName,
    pullRequestNumber: pending.pullRequestNumber,
  };
  const renotifyHours = releaseMergePushRenotifyHours();

  try {
    await db.releaseMergePushNotice.create({ data: { ...key, notifiedAt: now } });
    return true;
  } catch {
    // 既に記録がある＝一度は鳴らしている。以降は鳴らし直しの間隔だけで決める
  }

  if (renotifyHours <= 0) return false;
  const threshold = new Date(now.getTime() - renotifyHours * 60 * 60_000);
  const updated = await db.releaseMergePushNotice.updateMany({
    where: { ...key, notifiedAt: { lte: threshold } },
    data: { notifiedAt: now },
  });
  return updated.count > 0;
}

/** そのリポジトリで、いまマージ待ちに当たるPR以外の記録を消す */
async function forgetSettledNotices(
  repositoryFullName: string,
  keepPullRequestNumber: number | null,
): Promise<void> {
  await db.releaseMergePushNotice.deleteMany({
    where: {
      repositoryFullName,
      ...(keepPullRequestNumber === null
        ? {}
        : { pullRequestNumber: { not: keepPullRequestNumber } }),
    },
  });
}
