/**
 * GitHub Actionsの消費量（実行時間と課金額）を、organizationの課金レポートから取ってくる。
 *
 * **エンドポイントは新しい課金プラットフォームのものを使う。** 旧来の
 * `/orgs/{org}/settings/billing/actions`は410（This endpoint has been moved）を返すようになっており、
 * 無料枠（`included_minutes`）を返してくれる手段はもう無い。代わりに
 * `/organizations/{org}/settings/billing/usage`が、その暦月に発生した課金明細を
 * 「いつ・どのリポジトリで・どのSKUを・どれだけ」の粒度で返す。
 *
 * **読むのはユーザー本人のOAuthトークン。** 必要なスコープは`repo`または`admin:org`
 * （応答の`X-Accepted-Oauth-Scopes`で確認済み）で、ログイン時に要求している`repo`で足りる。
 * GitHub Appのインストールトークンにはorganizationの課金を読む権限が無いため使えない。
 *
 * **個人アカウントのインストールは対象外。** `/users/{username}/settings/billing/usage`は
 * `user`スコープを要求し、こちらは取得していない。
 *
 * **無料枠の残量は出せない。** Teamプランの3,000分/月を消費するのはprivateリポジトリの実行だけで、
 * publicリポジトリの実行は分数を消費しない（[docs/github-billing.md](../../../docs/github-billing.md)）。
 * ところがこのレポートはpublic/privateを区別せず、どちらも「gross全額がdiscountで相殺されてnet 0」
 * という同じ形で返ってくる。区別できない以上、残量メーターは作らずに実数と課金額だけを出す。
 */

import { toJstParts } from "@/lib/format-date-time";
import { githubFetchJsonWithEtag } from "@/lib/github/conditional-request";
import { GITHUB_API } from "@/lib/github/request";

/** 課金レポートの明細1件。使う項目だけを型にしている。 */
export type BillingUsageItem = {
  /** 発生時刻（UTCのISO8601） */
  date: string;
  /** `actions`・`ghas`など */
  product: string;
  /** `Actions Linux`・`Actions storage`など */
  sku: string;
  quantity: number;
  /** `Minutes`・`GigabyteHours`など */
  unitType: string;
  /** 実際に請求される金額（USD）。無料枠・publicリポジトリの実行は0になる */
  netAmount: number;
  repositoryName: string;
};

export type ActionsUsageRepository = {
  name: string;
  minutes: number;
  netAmount: number;
};

export type ActionsUsagePeriod = {
  minutes: number;
  netAmount: number;
  /** 実行時間の多い順。表示の都合で丸めた「ほかN件」を最後に持つことがある */
  repositories: ActionsUsageRepository[];
  /** `repositories`に入り切らず、まとめられたリポジトリの数 */
  otherRepositoryCount: number;
  otherMinutes: number;
};

export type ActionsUsage = {
  /** 集計した暦月（UTC基準。課金レポートの区切りに合わせる） */
  year: number;
  month: number;
  /** 「今日」の起点（日本時間の0時をepoch msにしたもの） */
  todayStartedAt: number;
  today: ActionsUsagePeriod;
  thisMonth: ActionsUsagePeriod;
  /** Actionsのストレージ（アーティファクト・キャッシュ）の消費（GB時） */
  storageGigabyteHours: number;
  storageNetAmount: number;
};

export type ActionsUsageResult =
  | { ok: true; usage: ActionsUsage }
  | { ok: false; status: number };

/** インストール1件ぶんの取得結果。APIの応答と画面側で同じ形を使う */
export type ActionsUsageEntry = {
  accountLogin: string;
  usage: ActionsUsage | null;
  /** 取得に失敗したときのHTTPステータス。成功・対象外ならnull */
  errorStatus: number | null;
  /** 個人アカウントのインストールなど、そもそも取得できない場合 */
  unsupported: boolean;
};

/**
 * リポジトリ別の内訳として個別に並べる件数。
 * これを超えたぶんは「ほかN件」へまとめるが、**課金が発生しているリポジトリは件数に関わらず残す**
 * （実行時間が短くてもprivateなら請求に載るため、埋もれると気付けない）。
 */
const REPOSITORIES_SHOWN = 5;

function isActionsMinutes(item: BillingUsageItem): boolean {
  return item.product.toLowerCase() === "actions" && item.unitType === "Minutes";
}

function isActionsStorage(item: BillingUsageItem): boolean {
  return item.product.toLowerCase() === "actions" && item.unitType === "GigabyteHours";
}

function summarizePeriod(items: BillingUsageItem[]): ActionsUsagePeriod {
  const byRepository = new Map<string, ActionsUsageRepository>();
  for (const item of items) {
    const name = item.repositoryName || "(リポジトリ不明)";
    const entry = byRepository.get(name) ?? { name, minutes: 0, netAmount: 0 };
    entry.minutes += item.quantity;
    entry.netAmount += item.netAmount;
    byRepository.set(name, entry);
  }

  const sorted = [...byRepository.values()].sort((a, b) => b.minutes - a.minutes);
  const shown = sorted.filter(
    (repository, index) => index < REPOSITORIES_SHOWN || repository.netAmount > 0,
  );
  const rest = sorted.filter((repository) => !shown.includes(repository));

  return {
    minutes: sorted.reduce((sum, repository) => sum + repository.minutes, 0),
    netAmount: sorted.reduce((sum, repository) => sum + repository.netAmount, 0),
    repositories: shown,
    otherRepositoryCount: rest.length,
    otherMinutes: rest.reduce((sum, repository) => sum + repository.minutes, 0),
  };
}

/**
 * 課金レポートの明細を、「今日」と「今月」の2つの期間へ集計する。
 *
 * **「今日」は日本時間の0時起点で数える。** レポートの`date`はUTCだが、画面に「今日」と出す以上、
 * 見ている人の1日に合わせるほうが読み取りやすい（本番のVPSもsubpcもUTCで動いているため、
 * 実行環境のローカルタイムで数えると9時間ずれる。`lib/format-date-time.ts`）。
 * 月初は、JSTの今日の始まりがUTCの前月に入るため、その9時間ぶんが「今日」から漏れる
 * （レポートを月単位でしか取っていないため）。月の合計には影響しない。
 */
export function summarizeActionsUsage(
  items: BillingUsageItem[],
  options: { year: number; month: number; todayStartedAt: number },
): ActionsUsage {
  const minuteItems = items.filter(isActionsMinutes);
  const todayItems = minuteItems.filter(
    (item) => Date.parse(item.date) >= options.todayStartedAt,
  );
  const storageItems = items.filter(isActionsStorage);

  return {
    year: options.year,
    month: options.month,
    todayStartedAt: options.todayStartedAt,
    today: summarizePeriod(todayItems),
    thisMonth: summarizePeriod(minuteItems),
    storageGigabyteHours: storageItems.reduce((sum, item) => sum + item.quantity, 0),
    storageNetAmount: storageItems.reduce((sum, item) => sum + item.netAmount, 0),
  };
}

/** 日本時間は+09:00固定（夏時間が無い）ので、単純な加減算でJSTの0時に戻せる */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の「今日の0時」をepoch msで返す */
export function startOfJstDay(now: Date): number {
  const parts = toJstParts(now);
  if (parts === null) return now.getTime();
  return Date.UTC(parts.year, parts.month - 1, parts.day) - JST_OFFSET_MS;
}

/**
 * organizationの当月ぶんのActions消費量を取る。
 *
 * **ETagの条件付きGETに載せる。** 応答は8月実績で約97KB・356件あり、設定を開くたびに素で
 * 取り直すとレート制限にも帯域にも響く。GitHubが304を返した間は消費に計上されない
 * （`conditional-request.ts`）。
 */
export async function fetchActionsUsage(
  organization: string,
  token: string,
  now: Date = new Date(),
): Promise<ActionsUsageResult> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const url = `${GITHUB_API}/organizations/${organization}/settings/billing/usage?year=${year}&month=${month}`;

  const result = await githubFetchJsonWithEtag<{ usageItems?: BillingUsageItem[] }>(url, token);
  if (!result.ok) {
    return { ok: false, status: result.status };
  }

  return {
    ok: true,
    usage: summarizeActionsUsage(result.data.usageItems ?? [], {
      year,
      month,
      todayStartedAt: startOfJstDay(now),
    }),
  };
}
