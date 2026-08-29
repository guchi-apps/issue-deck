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
 * **書式の正はシェル側**（`scripts/lib/local-repo-resolve.sh`の`local_repo_port_field`）。
 * あちらは `^[[:space:]]*([^[:space:]]+)[[:space:]]+([0-9]+)([[:space:]]+([0-9]+))?[[:space:]]*$`
 * にしか一致せず、行末コメントを認めない。ここの解析・生成も同じ形に揃える。
 * 3列目は帯の幅（省略時は`LOCAL_PORT_BAND_STEP`。#2478）。
 */

/** issue-deckのリポジトリ内での対応表の位置。 */
export const LOCAL_PORT_BAND_CONF_PATH = "scripts/local-repo-ports.conf";

/**
 * 帯の幅の既定値。対応表の冒頭に「帯の幅は原則1000」と書いてある。
 *
 * 対応表の3列目で個別に広げられる（#2478）。issue-deckは4000〜5999の2000ぶんを占める。
 * **帯の幅は「隣の帯まで何ポート空けてあるか」であり、Issue番号の上限ではない。**
 * 実際のポートはこの幅の中で折り返す（`scripts/lib/dev-server.sh`の`dev_server_port_for_issue`）。
 */
export const LOCAL_PORT_BAND_STEP = 1000;

/**
 * 払い出してよいベース値の上限。
 *
 * 実際のポートは「ベース値 + Issue番号」なので、上限を60000にしておくと
 * Issue番号が5000番台に達しても16bitのポート番号（65535）に収まる。
 */
export const MAX_LOCAL_PORT_BASE = 60000;

/**
 * ブラウザが接続を拒否するポート（#2466）。
 *
 * Chrome・Firefox・Safariは、他プロトコルの既定ポート（6000ならX11）へHTTPで繋ぐことを既定で
 * 拒否する（Chromeなら`ERR_UNSAFE_PORT`）。**開発サーバーがそのポートで正しく待ち受けていても
 * 画面は開けず、ホスト名がlocalhostでもtailnetのMagicDNS名でも同じ**なので、繋ぐ側では直せない。
 * 払い出す側で避けるしかない。
 *
 * 載せるのは**1000以上のものだけ**。帯のベース値は1000以上で、実際のポートは「ベース値 +
 * Issue番号」か「ベース値 + 0」なので、1000未満は出てこない。
 *
 * **シェル側と二重に持っている**（`scripts/lib/dev-server.sh`の
 * `DEV_SERVER_BROWSER_BLOCKED_PORTS`）。帯を払い出すのはこちら、実際に起動するのはあちらで、
 * 片方だけ直すと「払い出せた帯なのに確認環境が開けない」という形でずれる。突き合わせは
 * `local-port-bands.test.ts`が行うので、**変えるときは両方を揃える**。
 *
 * あちらは確認環境（「ベース値 + 0」）だけでなく、Issueごとのセッション（「ベース値 + Issue番号」）
 * にも同じ繰り上げを掛ける（#2470。`dev_server_port_for_issue`）。ブロック対象は6000だけでは
 * ないため、`6566`（dayspan #566）・`10080`（clip-hive #80）のように当たりうる。
 */
export const BROWSER_BLOCKED_PORTS: readonly number[] = [
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
];

/** そのポートがブラウザにブロックされるか。 */
export function isBrowserBlockedPort(port: number): boolean {
  return BROWSER_BLOCKED_PORTS.includes(port);
}

/** 対応表の1行。 */
export type LocalPortBand = {
  /** `guchi-apps/issue-deck` */
  repository: string;
  /** ベース値（`4000`） */
  base: number;
  /** 帯の幅（3列目。省略された行では`LOCAL_PORT_BAND_STEP`） */
  width: number;
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
    const match = /^\s*(\S+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (!match) continue;
    bands.push({
      repository: match[1],
      base: Number.parseInt(match[2], 10),
      width: match[3] ? Number.parseInt(match[3], 10) : LOCAL_PORT_BAND_STEP,
    });
  }
  return bands;
}

/** その帯が占める最後のポート（`4000`・幅`2000`なら`5999`）。 */
export function localPortBandEnd(band: LocalPortBand): number {
  return band.base + band.width - 1;
}

/**
 * 重なっている帯の組を挙げる（#2478）。
 *
 * 帯が重なると、同じポートを別リポジトリのIssueが使う。#2478はこれを「Issue番号が帯の幅を
 * 超える」形で踏んだ（issue-deckの`4000 + 2470 = 6470`がdayspanの6000帯へ入った）。採番側は
 * 帯の中で折り返すようにしたので、あとは**対応表そのものが重なっていないこと**を守れば足りる。
 * 突き合わせは`local-port-bands.test.ts`が実物の対応表に対して行う。
 */
export function findOverlappingLocalPortBands(
  bands: LocalPortBand[],
): { a: LocalPortBand; b: LocalPortBand }[] {
  const sorted = [...bands].sort((x, y) => x.base - y.base);
  const overlaps: { a: LocalPortBand; b: LocalPortBand }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].base <= localPortBandEnd(sorted[i - 1])) {
      overlaps.push({ a: sorted[i - 1], b: sorted[i] });
    }
  }
  return overlaps;
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
 *
 * **ブラウザがブロックするポート（#2466）はベース値にしない。** 確認環境
 * （`scripts/start-preview-dev.sh`）は「ベース値 + 0」で開くため、ベース値そのものが
 * ブロック対象だと、待ち受けていても画面を開けない帯を配ることになる。
 */
export function chooseNextLocalPortBase(bands: LocalPortBand[]): number | null {
  // **幅の広い帯（#2478）の終わりから進める。** 最大のベース値だけを見ると、issue-deckのように
  // 2000ぶんを占める帯の途中を次のリポジトリへ払い出してしまう。
  const max = bands.reduce(
    (current, band) => Math.max(current, localPortBandEnd(band) + 1),
    LOCAL_PORT_BAND_STEP,
  );
  let next = Math.ceil(max / LOCAL_PORT_BAND_STEP) * LOCAL_PORT_BAND_STEP;
  while (next <= MAX_LOCAL_PORT_BASE && isBrowserBlockedPort(next)) {
    next += LOCAL_PORT_BAND_STEP;
  }
  return next > MAX_LOCAL_PORT_BASE ? null : next;
}

/**
 * 対応表の1行を組み立てる（値の右端を既存の行に揃える）。
 *
 * 帯の幅は原則の1000と違うときだけ3列目として書く（#2478）。既定の幅を全行へ書き足すと、
 * 実データの差分が「幅を明示した」だけの行で埋まる。
 */
export function formatLocalPortBandLine(
  repository: string,
  base: number,
  width: number = LOCAL_PORT_BAND_STEP,
): string {
  const head = `${repository.padEnd(NAME_COLUMN_WIDTH)}${String(base).padStart(VALUE_COLUMN_WIDTH)}`;
  return width === LOCAL_PORT_BAND_STEP
    ? head
    : `${head}${String(width).padStart(VALUE_COLUMN_WIDTH)}`;
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
