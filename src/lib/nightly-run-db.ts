import { NIGHTLY_RUN_START_HOUR_DEFAULT, parseNightlyRunStartHour } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { resolveNightlyRunWindow, type NightlyRunSettings } from "@/lib/nightly-run";

/**
 * 夜間実行（#2772）のうち、**DBだけを読む軽い処理**。
 *
 * 起動処理（`nightly-run-launch.ts`）は`dispatch/jobs.ts`経由でGitHub Appの認証を読み込み、
 * そこはモジュール読み込みの時点で`GITHUB_APP_ID`等を要求する。確認待ちPushの巡回
 * （`notifications/check-user-push.ts`）はWebhookの受け口からも呼ばれ、その資格情報を必要と
 * しないため、こちらだけを読めるように分けている（`dispatch/pending-dispatch.ts`と同じ理由）。
 */

export async function readNightlyRunSettings(): Promise<NightlyRunSettings> {
  const row = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { nightlyRunEnabled: true, nightlyRunStartHour: true },
  });
  return {
    enabled: row?.nightlyRunEnabled ?? false,
    startHour: parseNightlyRunStartHour(row?.nightlyRunStartHour) ?? NIGHTLY_RUN_START_HOUR_DEFAULT,
  };
}

export function nightlyRunIssueKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

export type NightlyRunPushHold = {
  /** この時刻まで送らない */
  until: Date;
  /** 止めるIssueの鍵（`owner/repo#番号`） */
  keys: Set<string>;
};

/**
 * 夜間実行で今夜起動したIssueのうち、確認待ちPushをまだ止めておくべきものを返す（G1の指摘2）。
 *
 * 朝（`NIGHTLY_RUN_MORNING_HOUR`）を過ぎていれば`null`＝何も止めない。夜間実行がOFFでも、
 * ONだったあいだに起動したものがあれば止める（切った瞬間に鳴らさない）。
 */
export async function selectNightlyRunPushHold(now: Date): Promise<NightlyRunPushHold | null> {
  const settings = await readNightlyRunSettings();
  const window = resolveNightlyRunWindow(now, settings.startHour);
  if (now.getTime() >= window.morningAt.getTime()) return null;

  const entries = await db.nightlyRunEntry.findMany({
    where: { status: "LAUNCHED", nightKey: window.nightKey },
    select: { repositoryFullName: true, issueNumber: true },
  });
  if (entries.length === 0) return null;

  return {
    until: window.morningAt,
    keys: new Set(entries.map((entry) => nightlyRunIssueKey(entry.repositoryFullName, entry.issueNumber))),
  };
}
