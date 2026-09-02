import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  fetchLatestRelease,
  fetchReleaseNotesFile,
  type LatestRelease,
} from "@/lib/github/release-api";
import {
  isPushConfigured,
  sendPushNotification,
  type PushNotificationPayload,
} from "@/lib/notifications/push";

/**
 * リリース（本番反映）の完了のPush通知（#2725）。
 *
 * **これまでリリース通知はSignalyへのwebhookにしか流れていなかった**
 * （`.github/scripts/signaly-notify.sh`を`deploy.yml`の`notify-release`が呼ぶ）。
 * issue-deckはフリート全体のリリースを画面で扱っているのに、**出たことだけは別のアプリで
 * 受け取る**という形になっており、スマホに入れているPWAには届かない。ここで4種類目の
 * Push通知として、確認待ち（#838）・本番マージ待ち（#2376）・デプロイ起動漏れ（#2703）と
 * 同じ経路に載せる。**Signalyへの通知はそのまま残す**（宛先が1つ増えるだけ）。
 *
 * ## 既存3種と違い、これは「報せるだけ」の通知
 *
 * 他の3種はどれも「人が動かないと止まるもの」で、鳴らし直し（`RENOTIFY`）を持つ。
 * リリースは済んだことの報告なので**1回鳴らして終わり**にし、代わりに
 * `RELEASE_PUSH_SWEEP_INTERVAL_MINUTES=0`で丸ごと止められるようにしてある。
 *
 * ## 判定はGitHub Releaseそのものを見る
 *
 * issue-deckはこれまでReleaseのAPIを1度も呼んでいない（見ていたのはPRと
 * workflow runだけ）。**「本番へ出た版」を一意に指す値はタグしか無い**ため、ここだけは
 * Releaseを直接読む。`releases/latest`はdraftとprereleaseを除くので、欲しい絞り込みが
 * そのまま得られる。取得は**ETagの条件付きGET**を通すので、リリースが増えない間は
 * レート制限を消費しない。
 *
 * ## 鳴らした記録はDBに持つ
 *
 * `ReleasePushNotice`（リポジトリごとに1行）。`releases/latest`は「新しいかどうか」を
 * 教えてくれないので、**記録したタグと違うものが返ってきたときだけ鳴らす**という形でしか
 * 判定できない。**記録の無いリポジトリは鳴らさずタグだけ入れる**——入れずに始めると、
 * 導入直後の1巡で連携済みリポジトリぶんの通知が一斉に鳴る。
 */

/** 巡回の既定間隔（分）。304が返る間はレート制限を消費しないので、他の巡回と同じ5分に取る */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;

/**
 * これより古いリリースは鳴らさず、タグの記録だけ更新する既定の時間（時間）。
 *
 * 種まき（記録の無いリポジトリ）でほぼ防げるが、**記録が消えた・リポジトリを連携し直した
 * ときに何日も前のリリースが鳴る**のを止める最後の網。
 */
const DEFAULT_MAX_AGE_HOURS = 24;

/** 1回の巡回で見るリポジトリ数の上限。取りこぼしても次の巡回で拾える */
const SWEEP_REPOSITORY_LIMIT = 60;

/**
 * 通知本文の最大文字数。
 *
 * Signalyは1500文字まで載せるが、あちらは通知一覧の画面を持つ。OSの通知は数行しか
 * 見えないので、**先頭だけを見せて続きはアプリで読ませる**。
 */
export const RELEASE_PUSH_BODY_LIMIT = 300;

/** 更新内容を載せられなかったときの本文。**理由は区別しない**（`signaly-notify.sh`と同じ文面） */
export const RELEASE_PUSH_EMPTY_BODY = "今回のリリースでは、表示できる更新内容がありません。";

/** 巡回の間隔（分）。環境変数が読めない・数値でない場合は既定値。0以下は「巡回しない」 */
export function releasePushSweepIntervalMinutes(
  raw: string | undefined = process.env.RELEASE_PUSH_SWEEP_INTERVAL_MINUTES,
): number {
  return nonNegativeNumber(raw, DEFAULT_SWEEP_INTERVAL_MINUTES);
}

/** 鳴らす対象にする、リリースの新しさの上限（時間）。0にすると新しさを問わない */
export function releasePushMaxAgeHours(
  raw: string | undefined = process.env.RELEASE_PUSH_MAX_AGE_HOURS,
): number {
  return nonNegativeNumber(raw, DEFAULT_MAX_AGE_HOURS);
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * このリリースをどう扱うか。
 *
 * - `send` … 鳴らして記録する
 * - `record` … 鳴らさずタグだけ記録する（種まき・古すぎるリリース）
 * - `skip` … 何もしない（記録済みのタグと同じ＝新しいリリースが出ていない）
 */
export type ReleasePushDecision = "send" | "record" | "skip";

/**
 * 記録済みのタグと最新リリースを比べて、鳴らすかどうかを決める（純粋関数）。
 *
 * **「記録が無い＝初めて見るリポジトリ」は鳴らさない。** 連携した直後や導入直後に、
 * 過去に出たリリースを今出たものとして鳴らしてしまうため。
 */
export function decideReleasePush(params: {
  /** 前回記録したタグ。1度も記録していなければnull */
  recordedTagName: string | null;
  /** いまGitHubが返した最新リリースのタグ */
  tagName: string;
  /** そのリリースの公開時刻。取れなければnull */
  publishedAt: Date | null;
  now: Date;
  /** 0なら新しさを問わない */
  maxAgeHours: number;
}): ReleasePushDecision {
  if (params.recordedTagName === null) return "record";
  if (params.recordedTagName === params.tagName) return "skip";
  if (params.maxAgeHours > 0 && params.publishedAt) {
    const age = params.now.getTime() - params.publishedAt.getTime();
    if (age > params.maxAgeHours * 60 * 60_000) return "record";
  }
  return "send";
}

/**
 * `.github/release-notes.md`から、そのバージョンの更新内容を取り出す（純粋関数）。
 *
 * 判定は`.github/scripts/signaly-notify.sh`の`read_release_notes`と同じにする——
 * 先頭のHTMLコメント（「手で編集しない」の断り書き）を捨て、最初の見出し`# v1.2.3`が
 * 期待するバージョンと一致したときだけ本文を返す。**照合できなければ空を返す。**
 * リリースの流れの外でファイルが取り残されたとき、**古い文面を新しいバージョンの通知へ
 * 貼ってしまうほうが、本文が無いことより悪い**ため。
 *
 * **Signalyと違い、「使い方」（`RELEASE_USAGE`）は落とす。** OSの通知に見えるのは数行で、
 * 手順を並べると肝心の「何が変わったか」が押し出される。手順はアプリの更新履歴とSignalyで
 * 読めばよい（`reusable-release-develop-to-main.yml`が`**使い方**`の行を境に書き出す）。
 */
export function parseReleaseNotes(raw: string | null, tagName: string): string {
  if (!raw) return "";
  const lines = raw.split(/\r?\n/).filter((line) => !/^\s*<!--.*-->\s*$/.test(line));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) return "";

  const heading = /^#\s*(\S+)\s*$/.exec(lines[0]);
  if (!heading) return "";
  if (stripVersionPrefix(heading[1]) !== stripVersionPrefix(tagName)) return "";

  const changes = lines.slice(1);
  const usageAt = changes.findIndex((line) => line.trim() === "**使い方**");
  const body = (usageAt === -1 ? changes : changes.slice(0, usageAt)).join("\n").trim();
  if (body.length <= RELEASE_PUSH_BODY_LIMIT) return body;
  return `${body.slice(0, RELEASE_PUSH_BODY_LIMIT).trimEnd()}…`;
}

function stripVersionPrefix(value: string): string {
  return value.replace(/^v/, "");
}

/** 巡回が見つけた、新しく出たリリース1件 */
export type PublishedRelease = {
  repositoryFullName: string;
  tagName: string;
  /** 通知の本文に載せる更新内容。載せられなければ空文字 */
  notes: string;
};

/**
 * 通知の中身。1行目にリポジトリとバージョン、2行目に更新内容を置く。
 *
 * **タップ先はブランチ画面**（`pane=flow`）。リリースの状況・本番へ出ている版・次に乗る
 * Issueがそこに揃っている。PC（`pane`）とスマホ（`mscreen`）で現在地の持ち方が違うので
 * 両方を載せる（他の3種と同じ）。
 *
 * `tag`はリポジトリ＋バージョンで一意にする。**同じ`tag`にすると前のリリースの通知を
 * 置き換えてしまう**——マージ待ちと違い、こちらは1件ずつが別の出来事のため。
 */
export function buildReleasePushPayload(release: PublishedRelease): PushNotificationPayload {
  const repositoryName =
    release.repositoryFullName.split("/")[1] ?? release.repositoryFullName;
  return {
    title: `${repositoryName} ・ リリース ${release.tagName}`,
    body: release.notes || RELEASE_PUSH_EMPTY_BODY,
    url: "/dashboard?pane=flow&mscreen=flow",
    tag: `release:${release.repositoryFullName}@${release.tagName}`,
  };
}

export type ReleasePushResult = {
  /** 実際に巡回したか。間隔に達していない・無効化されている場合は`false` */
  swept: boolean;
  /** `RELEASE_PUSH_SWEEP_INTERVAL_MINUTES=0`で止めているか */
  disabled: boolean;
  /** リリースを1件以上持っていて実際に見たリポジトリ数 */
  repositories: number;
  /** 鳴らさずタグだけ記録したリポジトリ（種まき・古すぎるリリース） */
  recorded: string[];
  /** 実際に通知を送ったリリース */
  notified: PublishedRelease[];
  /** 状況を取得できなかったリポジトリ */
  failedRepositories: string[];
};

function emptyResult(overrides: Partial<ReleasePushResult> = {}): ReleasePushResult {
  return {
    swept: false,
    disabled: false,
    repositories: 0,
    recorded: [],
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
export function resetReleasePushSweepIntervalForTest(): void {
  lastSweptAt = null;
}

/**
 * 新しく出たリリースを巡回し、見つけたらPush通知する。
 *
 * **連携済みリポジトリ全部を1回の巡回で見る。** 呼ぶのはログインセッションを持たない
 * サブPCのpollerなので、ユーザー単位の絞り込みは母集団では行わない（他の巡回と同じ方針）。
 * 絞り込むのは宛先の側で、**そのリポジトリを非表示にしているユーザーへは送らない**（#2279）。
 *
 * ## GitHub APIの消費
 *
 * 巡回1回あたり、リポジトリごとにREST 1回（`releases/latest`）。**リリースが増えていない
 * 間は304が返り、レート制限を消費しない**。新しいリリースを見つけたときだけ、そのタグ時点の
 * `.github/release-notes.md`の取得が1回増える。
 */
export async function runReleasePushSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<ReleasePushResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = releasePushSweepIntervalMinutes();
  if (intervalMinutes <= 0) return emptyResult({ disabled: true });

  if (!options.force && lastSweptAt !== null) {
    if (now.getTime() - lastSweptAt < intervalMinutes * 60_000) return emptyResult();
  }
  lastSweptAt = now.getTime();

  // **購読が1件も無ければGitHubを叩かない**（マージ待ちの巡回と同じ）。送り先の無い巡回で
  // レート制限を使わない。ただし種まきもしないので、購読が増えた直後の1巡は全リポジトリが
  // 「記録が無い」状態から始まり、そこで初めてタグが入る（＝そのときも鳴らない）。
  if (!isPushConfigured()) return emptyResult({ swept: true });
  if ((await db.pushSubscription.count()) === 0) return emptyResult({ swept: true });

  const repositories = await db.repository.findMany({
    where: { archived: false },
    orderBy: { fullName: "asc" },
    take: SWEEP_REPOSITORY_LIMIT,
    select: {
      id: true,
      fullName: true,
      ownerLogin: true,
      name: true,
      installationId: true,
      installation: { select: { installationId: true } },
    },
  });

  // 同一installationのリポジトリ間でトークン取得を使い回す（マージ待ちの巡回と同じ）。
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
  const maxAgeHours = releasePushMaxAgeHours();

  for (const repository of repositories) {
    try {
      const token = await tokenFor(repository.installation.installationId);
      const latest = await fetchLatestRelease(repository.ownerLogin, repository.name, token);
      // リリースを1度も出していないリポジトリ（`vps`・`subpc`のように`tag`ジョブが無いもの）。
      if (!latest) continue;
      result.repositories += 1;

      const notice = await db.releasePushNotice.findUnique({
        where: { repositoryFullName: repository.fullName },
        select: { tagName: true },
      });
      const publishedAt = parsePublishedAt(latest);
      const decision = decideReleasePush({
        recordedTagName: notice?.tagName ?? null,
        tagName: latest.tagName,
        publishedAt,
        now,
        maxAgeHours,
      });
      if (decision === "skip") continue;

      // **送る前に記録を立てて席を取る**（他のPush通知と同じ。#2300）。取れなかったら
      // 別の巡回が既に掴んでいる
      if (!(await reserveReleasePush(repository.fullName, latest, publishedAt, decision, now))) {
        continue;
      }
      if (decision === "record") {
        result.recorded.push(repository.fullName);
        continue;
      }

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

      const published: PublishedRelease = {
        repositoryFullName: repository.fullName,
        tagName: latest.tagName,
        notes: parseReleaseNotes(
          // 本文の取得に失敗しても通知そのものは出す。**「出たこと」の方が本文より重い**
          await fetchReleaseNotes(repository.ownerLogin, repository.name, latest.tagName, token),
          latest.tagName,
        ),
      };
      await sendPushNotification(targets, buildReleasePushPayload(published));
      result.notified.push(published);
    } catch (error) {
      // 1リポジトリの取得失敗で他リポジトリの通知まで巻き込まない（他の巡回と同じ）。
      console.error(`[runReleasePushSweep] ${repository.fullName}:`, error);
      result.failedRepositories.push(repository.fullName);
    }
  }

  return result;
}

function parsePublishedAt(latest: LatestRelease): Date | null {
  if (!latest.publishedAt) return null;
  const value = new Date(latest.publishedAt);
  return Number.isNaN(value.getTime()) ? null : value;
}

/** 更新内容の取得に失敗しても通知を止めない。載せられるものが無いだけとして扱う */
async function fetchReleaseNotes(
  owner: string,
  repo: string,
  tagName: string,
  token: string,
): Promise<string | null> {
  try {
    return await fetchReleaseNotesFile(owner, repo, tagName, token);
  } catch (error) {
    console.error(`[runReleasePushSweep] ${owner}/${repo} の更新内容を読めませんでした:`, error);
    return null;
  }
}

/**
 * 「これから鳴らす」ことを先に記録して席を取る。取れたらtrue。
 *
 * 初回は`create`が、2回目以降は**タグが変わっていることを条件にした**`updateMany`が席になる。
 * どちらも一意キー（`repositoryFullName`）とタグの条件で確定するので、巡回が同時に何本
 * 走ってもトランザクションもロックも要らない。
 *
 * **送信の成否で記録を戻さない**（他のPush通知と同じ）。一時的な失敗のために次の巡回で
 * 鳴らし直すと、鳴り直しを持たない通知が二重に届きうる。
 */
async function reserveReleasePush(
  repositoryFullName: string,
  latest: LatestRelease,
  publishedAt: Date | null,
  decision: ReleasePushDecision,
  now: Date,
): Promise<boolean> {
  const data = {
    tagName: latest.tagName,
    publishedAt,
    notifiedAt: decision === "send" ? now : null,
  };

  try {
    await db.releasePushNotice.create({ data: { repositoryFullName, ...data } });
    return true;
  } catch {
    // 既に行がある＝2回目以降。以降はタグが変わっていることを条件に取り直す
  }

  const updated = await db.releasePushNotice.updateMany({
    where: { repositoryFullName, tagName: { not: latest.tagName } },
    data,
  });
  return updated.count > 0;
}
