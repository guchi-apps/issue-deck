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
 * PR一覧（PCのPRペイン・スマホのPR画面）の自動更新間隔（#1531・#1947）。ユーザーが選ぶ
 * 対象ではなく、CIの進捗やマージの状況に気づくのに更新ボタンを押させないための固定値。
 *
 * 元は「マージ待ち」ビュー（当時の名前は「完了したPR」）だけの間隔だったが、ヘッダーの
 * 「更新」ボタンを外した（#1947）ため、PR画面を開いている間はどのビューでもこの間隔で回す。
 *
 * **Issue一覧のポーリング（`use-issue-polling.ts`）とは値が同じでも定数を分ける。**
 * あちらは`GET /api/issues`（DBの読み取りだけ）で、こちらは1巡ごとにGitHub APIを
 * 「リポジトリ数のREST（ETagで304なら消費0）＋ draft以外のopen PR数のGraphQL
 * （条件付きGETが効かない）」だけ使う。冒頭の「1回の取得コストが重い画面ほど間隔を長くする」に
 * 従って片方だけ間隔を見直せるようにしておく（1つに寄せると、PR一覧を延ばしたいだけの
 * ときにIssue一覧まで巻き込む）。
 */
export const PULL_REQUEST_POLL_INTERVAL_MS = 10_000;

/**
 * Issue一覧（`use-issue-polling.ts`）の自動更新間隔（#1797）。**この画面だけは常時有効**で、
 * ユーザーが選ぶ対象でもない。
 *
 * 叩き先は`GET /api/issues`（DBの読み取りだけ）でGitHub APIを消費しないため、
 * 冒頭の「1回の取得コストが重い画面ほど間隔を長くする」から見て最も軽い側にあたる。
 * 値が同じでも`PULL_REQUEST_POLL_INTERVAL_MS`とは分けたままにする（そちらの注記を参照）。
 */
export const ISSUE_POLL_INTERVAL_MS = 10_000;

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
 * PR一覧は「PR画面（10秒）」と「ブランチ画面（ユーザーが選んだ間隔）」の
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

/**
 * 画面のヘッダーに出す自動更新の状態（#1797）。PR一覧・Issue一覧・ブランチ画面で同じ文言を
 * 使うため、ここ1か所から配る。
 *
 * **自動更新していないときも黙らない。** 「自動更新◯間隔」を出すか何も出さないかの2択だと、
 * 何も出ていないのが「自動更新していない」なのか「そもそもこの画面は状態を出さない」なのかを
 * 見分けられない（Issue一覧はまさに後者だった）。
 */
export function describeAutoRefreshState(intervalMs: AutoRefreshIntervalMs): string {
  if (intervalMs === null) return "手動更新のみ";
  return `自動更新${autoRefreshIntervalLabel(intervalMs)}`;
}

/**
 * 手動更新ボタンのツールチップ（#1797）。押すと何が起きるかと、放っておいても更新されるのかの
 * 両方を出す。ブランチ画面の「更新」・通知ベル・実行キューの更新インジケーターで共通に使う。
 */
export function describeRefreshButtonHint(intervalMs: AutoRefreshIntervalMs): string {
  return `今すぐ更新（${describeAutoRefreshState(intervalMs)}）`;
}
