/**
 * ローカルセッションの開発サーバーのポート帯（`scripts/local-repo-ports.conf`）の払い出し（#2225）。
 *
 * **このファイルは純粋関数だけにする**（`spec.ts`・`plan.ts`と同じ理由。ウィザードの確認
 * ステップが払い出し予定の帯を描く）。GitHubから対応表を取ってPRにするのは
 * `lib/github/local-port-band-api.ts`の役目。
 *
 * **なぜ立ち上げで払い出すのか。** 対応表に載っていないリポジトリは、汎用ランチャー
 * （`scripts/generic-start-issue.sh`）の既定 `3000 + Issue番号` に落ちる。未登録のリポジトリ
 * 同士が同じ帯へ相乗りし、同じ番号のIssueを別リポジトリで同時に起こすと開発サーバーの
 * ポートが衝突する（#1741・#1276）。#2213（`aide-bot`）で実際に漏れて手で足した。
 *
 * **書式の正はシェル側**（`scripts/lib/local-repo-resolve.sh`の`local_repo_port_base`）。
 * あちらは `^[[:space:]]*([^[:space:]]+)[[:space:]]+([0-9]+)[[:space:]]*$` にしか一致せず、
 * 行末コメントを認めない。ここの解析・生成も同じ形に揃える。
 */

/** issue-deckのリポジトリ内での対応表の位置。 */
export const LOCAL_PORT_BAND_CONF_PATH = "scripts/local-repo-ports.conf";

/** 帯の幅。対応表の冒頭に「帯の幅は原則1000」と書いてある。 */
export const LOCAL_PORT_BAND_STEP = 1000;

/**
 * 払い出してよいベース値の上限。
 *
 * 実際のポートは「ベース値 + Issue番号」なので、上限を60000にしておくと
 * Issue番号が5000番台に達しても16bitのポート番号（65535）に収まる。
 */
export const MAX_LOCAL_PORT_BASE = 60000;

/** 対応表の1行。 */
export type LocalPortBand = {
  /** `guchi-apps/issue-deck` */
  repository: string;
  /** ベース値（`4000`） */
  base: number;
};

/** 名前と値のあいだの整形。既存の行に合わせて値の右端を35桁目に揃える。 */
const NAME_COLUMN_WIDTH = 29;
const VALUE_COLUMN_WIDTH = 6;

/** 対応表を読む。`#`始まりの行・空行・書式に合わない行は捨てる。 */
export function parseLocalPortBands(conf: string): LocalPortBand[] {
  const bands: LocalPortBand[] = [];
  for (const rawLine of conf.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    bands.push({ repository: match[1], base: Number.parseInt(match[2], 10) });
  }
  return bands;
}

/** 既に載っているならそのベース値。載っていなければ`null`。 */
export function findLocalPortBand(bands: LocalPortBand[], repository: string): number | null {
  const found = bands.find((band) => band.repository === repository);
  return found ? found.base : null;
}

/**
 * 次に払い出す帯（現状の最大 + 1000）。
 *
 * **空きを探して詰めない。** 帯を外したリポジトリの番号を再利用すると、古いチェックアウトが
 * 残っているサブPCで前の持ち主と衝突しうる。上限を超えたら`null`を返し、人に決めさせる。
 */
export function chooseNextLocalPortBase(bands: LocalPortBand[]): number | null {
  const max = bands.reduce((current, band) => Math.max(current, band.base), 0);
  const next = max + LOCAL_PORT_BAND_STEP;
  return next > MAX_LOCAL_PORT_BASE ? null : next;
}

/** 対応表の1行を組み立てる（値の右端を既存の行に揃える）。 */
export function formatLocalPortBandLine(repository: string, base: number): string {
  return `${repository.padEnd(NAME_COLUMN_WIDTH)}${String(base).padStart(VALUE_COLUMN_WIDTH)}`;
}

/**
 * 対応表の末尾へ1件足した内容を返す。
 *
 * 由来のコメントを1行添える。**行末コメントにはしない**（シェル側の正規表現が行全体で
 * 一致するため、`guchi-apps/foo 25000 # メモ` は丸ごと無視される）。
 */
export function appendLocalPortBand(
  conf: string,
  entry: { repository: string; base: number; comment: string },
): string {
  const body = conf.replace(/\n+$/, "");
  return `${body}\n# ${entry.comment}\n${formatLocalPortBandLine(entry.repository, entry.base)}\n`;
}
