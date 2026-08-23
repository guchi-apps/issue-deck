/**
 * `guchi-apps/vps`の中身から「いま何が使われているか」を読み取る（#2188）。
 *
 * **このファイルは純粋関数だけにする**（文字列を受け取って解析する）。GitHubから取ってくる
 * のは`lib/github/vps-inventory-api.ts`の役目で、こちらはウィザードのコンポーネントからも
 * 読めるようにしておく（docs/code-map.md「`issues-api.ts`を辿るモジュールを画面から
 * importしない」）。
 *
 * **読む先は3つで、どれも「推測しない」ための取り決めがある。**
 *
 * 1. **ポートとドメインの正はvps READMEの2つの表**（「アプリ一覧」と「予約済みポート
 *    （未デプロイ）」）。README自身が「ドメイン・ポート・プロセス管理方式の一次情報は
 *    この表のみです」と書いており、**まだデプロイしていない予約も2つ目の表に載る**ため、
 *    片方だけを読むと予約済みのポートを空きとして払い出してしまう。
 * 2. **READMEの散文にある「空きは〜」は読まない。** 実際に古くなっている（`aide`が
 *    3114を使い始めた後も「3114以降」が空きのままになっていた）。表から計算する。
 * 3. **サブドメインの重複はvhostの`ServerName`／`ServerAlias`で見る。ファイル名で見ない。**
 *    `wordpress.conf`の`ServerName`が`blog.gucchii.com`、`gucchii.conf`が`gucchii.com`と
 *    いうように、ファイル名とホスト名は一致しない。ファイル名で判定すると`blog`を
 *    空きだと誤って答える。
 *
 * **PM2の設定は読まない。** `guchi-apps/vps`に`pm2/`ディレクトリは無く（READMEの構成図には
 * 残っているが実体が無い）、`ecosystem.config.js`は各アプリの自リポジトリで管理されている。
 * プロセス管理方式もアプリ一覧の表に書いてあるので、そちらを読めば足りる。
 */

/** vps READMEのアプリ一覧の1行。 */
export type VpsAppEntry = {
  /** アプリ名（表の1列目） */
  name: string;
  /** ホスト名（`gucchii.com/shopping-list`のようなパス配置ならホスト部分だけ） */
  hostname: string | null;
  /** 公開URLのパス部分（パス配置のときだけ。`shopping-list`） */
  basePath: string | null;
  port: number | null;
};

/** 予約済みポート（未デプロイ）の表の1行。 */
export type VpsReservedPort = {
  port: number;
  app: string;
  hostname: string | null;
};

export type VpsInventory = {
  apps: VpsAppEntry[];
  reserved: VpsReservedPort[];
};

/** 表の区切り行（`|---|---|`）か。 */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

/** Markdownのテーブル行をセルへ割る。表の行でなければ`null`。 */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.map((cell) => cell.trim());
}

/**
 * 見出しの直後にある最初のテーブルの本文行を返す。
 *
 * **次の見出し（`## `／`### `）に当たったら打ち切る。** 節をまたいで拾うと、
 * 「アプリ一覧」を読んでいるつもりでuser systemdユニットの表まで混ざる。
 */
function rowsUnderHeading(markdown: string, heading: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];

  const rows: string[][] = [];
  let seenTable = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{2,3} /.test(line.trim())) break;
    const cells = tableCells(line);
    if (!cells) {
      // 表が始まった後の空行・散文は表の終わり
      if (seenTable) break;
      continue;
    }
    if (isSeparatorRow(cells)) {
      seenTable = true;
      continue;
    }
    if (!seenTable) continue; // ヘッダー行
    rows.push(cells);
  }
  return rows;
}

/** Markdownのリンク記法・強調・コード記法を落として素の文字列にする。 */
function plainText(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}

/**
 * 「ドメイン / ポート」欄を解析する。
 *
 * 実際に現れる形は次のとおり。
 * - `car.gucchii.com / 3104`
 * - `gucchii.com/shopping-list / 3101`（パス配置）
 * - `klondike.game.gucchii.com`（ポート無しの静的サイト）
 * - `—`（VPS外・リポジトリのみ）
 */
export function parseLocationCell(cell: string): {
  hostname: string | null;
  basePath: string | null;
  port: number | null;
} {
  const text = plainText(cell);
  if (!text || text === "—" || text === "-") return { hostname: null, basePath: null, port: null };

  // 場所とポートの区切りは**前後に空白のあるスラッシュ**。パス配置（`gucchii.com/shopping-list`）の
  // スラッシュには空白が無いので、これで取り違えない
  const separator = text.indexOf(" / ");
  const place = (separator < 0 ? text : text.slice(0, separator)).trim();
  const portText = separator < 0 ? "" : text.slice(separator + 3).trim();
  const port = portText ? Number.parseInt(portText, 10) : Number.NaN;

  const slash = place.indexOf("/");
  const hostname = slash < 0 ? place : place.slice(0, slash);
  const basePath = slash < 0 ? null : place.slice(slash + 1) || null;

  return {
    hostname: hostname || null,
    basePath,
    port: Number.isFinite(port) ? port : null,
  };
}

/** vpsのREADMEから、アプリ一覧と予約済みポートの2つの表を読む。 */
export function parseVpsInventory(readme: string): VpsInventory {
  const apps: VpsAppEntry[] = [];
  for (const cells of rowsUnderHeading(readme, "## アプリ一覧")) {
    // アプリ一覧は `| アプリ | 説明 | ドメイン / ポート | プロセス管理 | リポジトリ |`
    if (cells.length < 3) continue;
    const name = plainText(cells[0]);
    if (!name || name === "—") continue;
    const { hostname, basePath, port } = parseLocationCell(cells[2]);
    apps.push({ name, hostname, basePath, port });
  }

  const reserved: VpsReservedPort[] = [];
  for (const cells of rowsUnderHeading(readme, "### 予約済みポート（未デプロイ）")) {
    // `| ポート | アプリ | 想定ドメイン | 出典 | 状態 |`。空表のときは `| — | — | ... |`
    if (cells.length < 3) continue;
    const port = Number.parseInt(plainText(cells[0]), 10);
    if (!Number.isFinite(port)) continue;
    reserved.push({
      port,
      app: plainText(cells[1]),
      hostname: parseLocationCell(cells[2]).hostname,
    });
  }

  return { apps, reserved };
}

/**
 * 払い出し済みのポート。**アプリ一覧と予約済みの両方を足す**（予約を落とすと二重払い出しになる）。
 */
export function usedPorts(inventory: VpsInventory): Set<number> {
  const ports = new Set<number>();
  for (const app of inventory.apps) {
    if (app.port !== null) ports.add(app.port);
  }
  for (const entry of inventory.reserved) ports.add(entry.port);
  return ports;
}

/** 範囲の中でいちばん小さい空き番号。空きが無ければ`null`。 */
export function chooseAvailablePort(
  used: Set<number>,
  range: { from: number; to: number },
): number | null {
  for (let port = range.from; port <= range.to; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

/**
 * VirtualHostの`ServerName`・`ServerAlias`を取り出す。
 *
 * `ServerAlias`は1行に複数書ける（`ServerAlias a.example.com b.example.com`）。
 * 行頭の`#`はコメントなので無視する。
 */
export function parseServerNames(vhostConf: string): string[] {
  const names: string[] = [];
  for (const rawLine of vhostConf.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^Server(?:Name|Alias)\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const name of match[1].split(/\s+/)) {
      const normalized = name.trim().toLowerCase().replace(/\.$/, "");
      if (normalized) names.push(normalized);
    }
  }
  return names;
}

export type VpsHostnameUsage = {
  /** vhostの`ServerName`／`ServerAlias`に現れるホスト名 */
  serverNames: string[];
  /** READMEのアプリ一覧に現れるホスト名 */
  listedHostnames: string[];
};

/** READMEとvhostの両方から、いま使われているホスト名を集める。 */
export function collectHostnameUsage(
  inventory: VpsInventory,
  vhostContents: string[],
): VpsHostnameUsage {
  const serverNames = new Set<string>();
  for (const conf of vhostContents) {
    for (const name of parseServerNames(conf)) serverNames.add(name);
  }
  const listed = new Set<string>();
  for (const app of inventory.apps) {
    if (app.hostname) listed.add(app.hostname.toLowerCase());
  }
  for (const entry of inventory.reserved) {
    if (entry.hostname) listed.add(entry.hostname.toLowerCase());
  }
  return { serverNames: [...serverNames], listedHostnames: [...listed] };
}

/** そのホスト名が既に使われているか。 */
export function isHostnameTaken(hostname: string, usage: VpsHostnameUsage): boolean {
  const target = hostname.toLowerCase();
  return usage.serverNames.includes(target) || usage.listedHostnames.includes(target);
}

/**
 * ポートの根拠を画面に出すための文言（「3101〜3111が使用中」ではなく、実際に埋まっている
 * 番号を並べる）。**多いときは省略する**が、省略したことが分かるようにする。
 */
export function describeUsedPorts(
  used: Set<number>,
  range: { from: number; to: number },
  limit = 12,
): string {
  const inRange = [...used].filter((port) => port >= range.from && port <= range.to).sort((a, b) => a - b);
  if (inRange.length === 0) return `${range.from}〜${range.to}に使用中のポートはありません`;
  if (inRange.length <= limit) return `使用中: ${inRange.join("・")}`;
  return `使用中: ${inRange.slice(0, limit).join("・")} ほか${inRange.length - limit}件`;
}
