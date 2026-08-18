/**
 * 画面の自動更新の間隔（#1531・#1767）。
 *
 * 間隔はミリ秒で持ち、`null`が「自動更新しない」。真偽値にしないのは、ブランチ画面で
 * ユーザーが間隔を選べるようにしたため（#1767）——「有効かどうか」と「何分間隔か」を
 * 別々に持つと、片方だけを見た側が実際とは違う間隔を画面に出せてしまう。
 *
 * **1回の取得コストが重い画面ほど間隔を長くする。** ブランチ画面の1巡は
 * 「リポジトリ数（GraphQL）＋ リポジトリ数×2（REST・ETagで304なら消費0）＋
 * PRのCI状態（GraphQL。installationごとに数回で、PR件数には比例しない。#1962）」で、
 * 26リポジトリなら1分間隔で毎時1,600ポイント前後のGraphQL（上限5,000ポイント/時）を使う。
 * 既定を「自動更新しない」にしているのはこのため。
 */
export type AutoRefreshIntervalMs = number | null;

export type AutoRefreshOption = {
  value: AutoRefreshIntervalMs;
  /** メニューに出す文言 */
  label: string;
};

/** ユーザーが選べる間隔（#1767）。ブランチ画面のメニューはこの順で並ぶ */
export const AUTO_REFRESH_INTERVAL_OPTIONS: AutoRefreshOption[] = [
  { value: null, label: "自動更新しない" },
  { value: 60_000, label: "1分間隔" },
  { value: 300_000, label: "5分間隔" },
  { value: 600_000, label: "10分間隔" },
];

/**
 * 「完了したPR」ビューの自動更新間隔（#1531）。ユーザーが選ぶ対象ではなく、
 * CIが確定したPRに気づくのに更新ボタンを押させないための固定値。
 */
export const COMPLETED_PULL_REQUEST_POLL_INTERVAL_MS = 10_000;

/** 「1分間隔」のように画面へ出す文言にする。分で割り切れない値は秒で出す */
export function autoRefreshIntervalLabel(intervalMs: number): string {
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}分間隔`;
  return `${Math.round(intervalMs / 1_000)}秒間隔`;
}

/**
 * localStorageから読んだ値を選択肢のいずれかへ正規化する。
 *
 * 保存されているのは端末側のJSONで、選択肢を減らした後や手で書き換えられた後にも
 * 読まれる。**知らない値は「自動更新しない」へ倒す**——数値であれば何でも間隔として
 * 受け入れると、1秒間隔のような値でGitHub APIを叩き続けることになる。
 */
export function normalizeAutoRefreshInterval(value: unknown): AutoRefreshIntervalMs {
  const option = AUTO_REFRESH_INTERVAL_OPTIONS.find((candidate) => candidate.value === value);
  return option ? option.value : null;
}

/**
 * 同じ取得に対して複数の自動更新の要求が重なったとき、短い方を採る。
 *
 * PR一覧は「完了したPRビュー（10秒）」と「ブランチ画面（ユーザーが選んだ間隔）」の
 * 両方から自動更新の対象になる。長い方を採ると、短い間隔を求めている画面の要求が
 * 満たされない。
 */
export function shorterAutoRefreshInterval(
  a: AutoRefreshIntervalMs,
  b: AutoRefreshIntervalMs,
): AutoRefreshIntervalMs {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
