/**
 * 構想メモ（`guchi-apps/ideas`の`ideas/<候補名>/README.md`）から、立ち上げウィザードの
 * 決めごとを読み取る（#2432。置き場を作ったのは#2430）。
 *
 * **このファイルは純粋関数だけにする。** ウィザードのコンポーネントが直接importするため、
 * `lib/github/`を読んではいけない（`spec.ts`と同じ制約）。GitHubから本文を取る処理は
 * `lib/github/ideas-api.ts`側に置く。
 *
 * **読めなかった項目は既定値のままにして、読めたものだけを返す。** 構想メモは人が手で書く
 * ファイルで、雛形（`templates/idea.md`）どおりに埋まっている保証が無い。1項目でも解釈
 * できなければ全体を捨てる作りにすると、転記の手間を減らすという目的が達成できない
 * （`parse.ts`が「知らない値は全体を`null`にする」のとは方針が逆なのは、あちらが実際に
 * リポジトリを作る経路で、こちらが**人が見て直せる入力欄を埋めるだけ**の経路だから）。
 *
 * **雛形のまま触られていない行は「未決」として扱う。** 雛形の値の欄には選択肢そのもの
 * （`public / private`）が書いてあるので、選択肢を2つ以上同時に指せる値は選ばれていないと見る。
 */

import {
  isValidThemeColor,
  newAppKindProfile,
  databaseNameFor,
  type NewAppAuth,
  type NewAppIconPlan,
  type NewAppKind,
  type NewAppSpec,
  type NewAppUrlMode,
} from "@/lib/new-app/spec";

/** 構想の置き場（#2430）。 */
export const IDEA_REPOSITORY_OWNER = "guchi-apps";
export const IDEA_REPOSITORY_NAME = "ideas";
export const IDEA_REPOSITORY = `${IDEA_REPOSITORY_OWNER}/${IDEA_REPOSITORY_NAME}`;

/** 構想メモの置き場（`ideas/<候補名>/README.md`）。 */
export const IDEA_DIRECTORY = "ideas";

/**
 * 読み取る項目。`NewAppSpec`のキーと1対1だが、サブドメインとパスは構想メモでは1行なので
 * `placement`にまとめる（どちらへ入れるかは「公開URLの取り方」で決まる）。
 */
export type IdeaFieldKey =
  | "displayName"
  | "repositoryName"
  | "visibility"
  | "summary"
  | "kind"
  | "urlMode"
  | "placement"
  | "port"
  | "databaseName"
  | "auth"
  | "multiAgent"
  | "appTitle"
  | "pwa"
  | "offline"
  | "iconPlan"
  | "themeColor"
  | "changelog"
  | "screenshotBypass";

/** 読み取れた1項目。画面の「構想から読み込んだ項目」に出す。 */
export type IdeaFilledField = {
  key: IdeaFieldKey;
  /** 画面に出す項目名 */
  label: string;
  /** 画面に出す値（`next-db`ではなく「Next.js + DB」） */
  display: string;
};

export type IdeaImport = {
  /** `# <構想の名前>`の見出し。取れなければ`null` */
  title: string | null;
  /** `- 状態:`の行。取れなければ`null` */
  state: string | null;
  /** 「仕様案」の表が見つかったか。偽なら雛形から写していないか、表を消している */
  hasSpecTable: boolean;
  /** 読み取れた値だけを持つ部分的な仕様 */
  values: Partial<NewAppSpec>;
  /** 読み取れた項目 */
  filled: IdeaFilledField[];
  /** 表にはあるが空欄・「未決」・雛形のままだった項目名 */
  undecided: string[];
  /** 値は書かれているが解釈できなかった項目 */
  unreadable: { label: string; raw: string }[];
};

/**
 * `ideas/<候補名>/<ファイル>.md`の形か。
 *
 * **画面から来たパスをGitHubのcontents APIへ渡す前に必ず通す。** 構想の置き場の他の場所
 * （`CLAUDE.md`・`.github/`）を読める形にしない。`..`と絶対パスは弾く。
 */
export function isIdeaDocPath(path: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return false;
  return new RegExp(`^${IDEA_DIRECTORY}/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\.md$`).test(path);
}

/**
 * 立ち上げても意味が無い状態（画面で注意を出す）。
 *
 * **選択肢が2つ以上並んでいる行は雛形のままと見る**（`検討中 / 立ち上げ済み / 見送り`）。
 * そのまま拾うと、まだ何も選んでいない構想に「立ち上げ済み」の注意が出る。
 */
export function isIdeaClosed(state: string | null): boolean {
  if (!state) return false;
  const hits = ["検討中", "立ち上げ済み", "見送り"].filter((word) => state.includes(word));
  if (hits.length !== 1) return false;
  return hits[0] !== "検討中";
}

const FIELD_LABELS: Record<IdeaFieldKey, string> = {
  displayName: "アプリ名",
  repositoryName: "リポジトリ名",
  visibility: "公開範囲",
  summary: "概要",
  kind: "種別",
  urlMode: "公開URLの取り方",
  placement: "サブドメイン / パス",
  port: "本番ポート",
  databaseName: "DB名",
  auth: "ログイン",
  multiAgent: "マルチエージェント運用",
  appTitle: "ブラウザのタブに出る名前",
  pwa: "PWA対応",
  offline: "オフライン対応",
  iconPlan: "アイコンとテーマカラー",
  themeColor: "テーマカラー",
  changelog: "更新履歴",
  screenshotBypass: "CI撮影の認証バイパス",
};

/**
 * 項目名の突き合わせ。**前方から順に、正規化した項目名へ含まれるものを採る。**
 * 雛形の項目名には括弧書きの説明が付く（`アプリ名（画面に出る名前。日本語可）`）ため、
 * 完全一致では拾えない。「アイコンとテーマカラー」は「テーマカラー」を含むので先に置く。
 */
const FIELD_KEYWORDS: { key: IdeaFieldKey; keyword: string }[] = [
  { key: "iconPlan", keyword: "アイコンとテーマカラー" },
  { key: "themeColor", keyword: "テーマカラー" },
  { key: "displayName", keyword: "アプリ名" },
  { key: "repositoryName", keyword: "リポジトリ名" },
  { key: "visibility", keyword: "公開範囲" },
  { key: "summary", keyword: "概要" },
  { key: "kind", keyword: "種別" },
  { key: "urlMode", keyword: "公開URL" },
  { key: "placement", keyword: "サブドメイン" },
  { key: "port", keyword: "ポート" },
  { key: "databaseName", keyword: "DB名" },
  { key: "databaseName", keyword: "データベース" },
  { key: "auth", keyword: "ログイン" },
  { key: "multiAgent", keyword: "マルチエージェント" },
  { key: "appTitle", keyword: "タブに出る名前" },
  { key: "pwa", keyword: "PWA" },
  { key: "offline", keyword: "オフライン" },
  { key: "changelog", keyword: "更新履歴" },
  { key: "screenshotBypass", keyword: "認証バイパス" },
];

/** 空欄と同じ扱いにする値。 */
const UNDECIDED_VALUES = new Set(["未決", "未定", "不明", "-", "--", "—", "ー", "tbd", "n/a"]);

/** 「無し」を表す値（ポートとDB名で使う）。 */
const NONE_VALUES = new Set(["無し", "なし", "不要", "none", "無"]);

function normalizeLabel(label: string): string {
  return label
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[`*\s　]/g, "")
    .toLowerCase();
}

function normalizeValue(raw: string): string {
  return raw.replace(/[`*]/g, "").replace(/　/g, " ").trim();
}

/** 埋められていない値か。雛形の`<…>`のままのものも含む。 */
function isUnfilled(value: string): boolean {
  if (value === "") return true;
  if (UNDECIDED_VALUES.has(value.toLowerCase())) return true;
  return /^<.*>$/.test(value);
}

function compact(value: string): string {
  return value.replace(/[\s　]/g, "").toLowerCase();
}

/**
 * 選択肢から1つを選ぶ。**2つ以上に当たる値は「選ばれていない」と見る**——雛形の値の欄には
 * 選択肢そのもの（`public / private`）が書かれているため、そのままなら未決として扱う。
 * どれにも当たらなければ`"unreadable"`。
 */
function pickChoice<T>(value: string, table: [string, T][]): T | "undecided" | "unreadable" {
  const tokens = value
    .split(/[/／、,]/)
    .map((token) => compact(token))
    .filter((token) => token !== "");
  const hits = new Set<T>();
  for (const token of tokens) {
    for (const [alias, result] of table) {
      if (token === alias || token.includes(alias)) {
        hits.add(result);
        break;
      }
    }
  }
  if (hits.size === 0) return "unreadable";
  if (hits.size > 1) return "undecided";
  return [...hits][0];
}

const KIND_ALIASES: [string, NewAppKind][] = [
  ["next.js+db", "next-db"],
  ["nextjs+db", "next-db"],
  ["next-db", "next-db"],
  ["next.js+mariadb", "next-db"],
  ["fastapi", "fastapi"],
  ["静的", "static"],
  ["static", "static"],
  ["next.js", "next"],
  ["nextjs", "next"],
  ["next", "next"],
];

const AUTH_ALIASES: [string, NewAppAuth][] = [
  ["supabase", "supabase-google"],
  ["fastapi", "fastapi-google"],
  ["無し", "none"],
  ["なし", "none"],
  ["none", "none"],
];

const VISIBILITY_ALIASES: [string, "public" | "private"][] = [
  ["public", "public"],
  ["private", "private"],
  ["公開", "public"],
  ["非公開", "private"],
];

const URL_MODE_ALIASES: [string, NewAppUrlMode][] = [
  ["サブドメイン", "subdomain"],
  ["subdomain", "subdomain"],
  ["パス", "path"],
  ["path", "path"],
];

const ICON_PLAN_ALIASES: [string, NewAppIconPlan][] = [
  ["暫定", "provisional"],
  ["用意", "prepared"],
];

/**
 * 真偽値の言い換え。**否定形を先に置く**——部分一致で拾うため、`不要`が`要`に、
 * `no`が`yes`より後にあると取り違える。
 */
const YES_NO_ALIASES: [string, boolean][] = [
  ["いいえ", false],
  ["しない", false],
  ["不要", false],
  ["no", false],
  ["false", false],
  ["はい", true],
  ["する", true],
  ["必要", true],
  ["yes", true],
  ["true", true],
];

type SpecRow = { label: string; value: string };

/**
 * 「仕様案」の表を取り出す。見出しが無ければ、`| 項目 | 値 |`の見出し行を持つ表を全体から探す。
 */
function findSpecRows(markdown: string): SpecRow[] | null {
  const lines = markdown.split(/\r?\n/);
  let start = lines.findIndex((line) => /^#{2,3}\s*仕様案/.test(line.trim()));
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#{1,3}\s/.test(line.trim()));
    const rows = collectTableRows(end === -1 ? rest : rest.slice(0, end));
    if (rows.length > 0) return rows;
  }

  // 見出しを消している構想メモのために、表そのものからも探す
  start = lines.findIndex((line) => {
    const cells = splitRow(line);
    return cells !== null && compact(cells[0] ?? "") === "項目" && compact(cells[1] ?? "") === "値";
  });
  if (start === -1) return null;
  const rows = collectTableRows(lines.slice(start));
  return rows.length > 0 ? rows : null;
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function collectTableRows(lines: string[]): SpecRow[] {
  const rows: SpecRow[] = [];
  let seenTable = false;
  for (const line of lines) {
    const cells = splitRow(line);
    if (cells === null) {
      // 表が始まったあとの空行以外は表の終わり
      if (seenTable && line.trim() !== "") break;
      continue;
    }
    seenTable = true;
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    const label = cells[0] ?? "";
    if (compact(label) === "項目") continue;
    if (label.trim() === "") continue;
    rows.push({ label, value: cells[1] ?? "" });
  }
  return rows;
}

function findTitle(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const title = normalizeValue(match[1]);
    return isUnfilled(title) ? null : title;
  }
  return null;
}

function findState(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^-\s*状態\s*[:：]\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const state = normalizeValue(match[1]);
    return state === "" ? null : state;
  }
  return null;
}

/** 「一言でいうと」の本文。概要が空のときの穴埋めに使う。 */
function findOneLiner(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,3}\s*一言でいうと/.test(line.trim()));
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break;
    const text = normalizeValue(line.replace(/^[-*]\s*/, ""));
    if (text === "" || text.startsWith("<!--")) continue;
    if (isUnfilled(text)) continue;
    return text;
  }
  return null;
}

/**
 * 構想メモのMarkdownを読む。**表が無くても`null`は返さない**——タイトルだけでも
 * アプリ名の穴埋めには使えるので、読めた範囲を返して画面に判断させる。
 */
export function parseIdeaDoc(markdown: string): IdeaImport {
  const title = findTitle(markdown);
  const state = findState(markdown);
  const rows = findSpecRows(markdown);

  const values: Partial<NewAppSpec> = {};
  const filled: IdeaFilledField[] = [];
  const undecided: string[] = [];
  const unreadable: { label: string; raw: string }[] = [];
  const raw = new Map<IdeaFieldKey, string>();

  for (const row of rows ?? []) {
    const normalized = normalizeLabel(row.label);
    const match = FIELD_KEYWORDS.find((entry) => normalized.includes(normalizeLabel(entry.keyword)));
    if (!match) continue;
    if (raw.has(match.key)) continue;
    raw.set(match.key, normalizeValue(row.value));
  }

  const add = (key: IdeaFieldKey, display: string) => {
    filled.push({ key, label: FIELD_LABELS[key], display });
  };
  const markUndecided = (key: IdeaFieldKey) => {
    if (!undecided.includes(FIELD_LABELS[key])) undecided.push(FIELD_LABELS[key]);
  };
  const markUnreadable = (key: IdeaFieldKey, value: string) => {
    unreadable.push({ label: FIELD_LABELS[key], raw: value });
  };

  /** 選択肢の項目を1つ読む。 */
  const readChoice = <T>(key: IdeaFieldKey, table: [string, T][], apply: (value: T) => string) => {
    const value = raw.get(key);
    if (value === undefined) return;
    if (isUnfilled(value)) {
      markUndecided(key);
      return;
    }
    const picked = pickChoice(value, table);
    if (picked === "undecided") markUndecided(key);
    else if (picked === "unreadable") markUnreadable(key, value);
    else add(key, apply(picked));
  };

  /** 自由入力の項目を1つ読む。`apply`が`null`を返したら解釈できなかった扱いにする。 */
  const readText = (key: IdeaFieldKey, apply: (value: string) => string | null) => {
    const value = raw.get(key);
    if (value === undefined) return;
    if (isUnfilled(value)) {
      markUndecided(key);
      return;
    }
    const display = apply(value);
    if (display === null) markUnreadable(key, value);
    else add(key, display);
  };

  readText("displayName", (value) => {
    values.displayName = value;
    return value;
  });
  readText("repositoryName", (value) => {
    const name = compact(value);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) return null;
    values.repositoryName = name;
    return name;
  });
  readChoice("visibility", VISIBILITY_ALIASES, (value) => {
    values.visibility = value;
    return value;
  });
  readText("summary", (value) => {
    values.summary = value;
    return value;
  });
  readChoice("kind", KIND_ALIASES, (value) => {
    values.kind = value;
    return newAppKindProfile(value).label;
  });
  readChoice("urlMode", URL_MODE_ALIASES, (value) => {
    values.urlMode = value;
    return value === "subdomain" ? "サブドメイン" : "パス";
  });
  readText("port", (value) => {
    if (NONE_VALUES.has(compact(value))) {
      values.port = null;
      return "無し";
    }
    const port = Number.parseInt(value.replace(/[^0-9]/g, ""), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    values.port = port;
    return String(port);
  });
  readText("databaseName", (value) => {
    if (NONE_VALUES.has(compact(value))) {
      values.databaseName = null;
      return "無し";
    }
    const name = compact(value);
    if (!/^[a-z0-9_]+$/.test(name)) return null;
    values.databaseName = name;
    return name;
  });
  readChoice("auth", AUTH_ALIASES, (value) => {
    values.auth = value;
    return value === "none"
      ? "なし"
      : value === "supabase-google"
        ? "Supabase Auth（Google）"
        : "FastAPI + Google OAuth";
  });
  readChoice("multiAgent", YES_NO_ALIASES, (value) => {
    values.multiAgent = value;
    return value ? "対応させる" : "対応させない";
  });
  readText("appTitle", (value) => {
    values.appTitle = value;
    return value;
  });
  readChoice("pwa", YES_NO_ALIASES, (value) => {
    values.pwa = value;
    return value ? "する" : "しない";
  });
  readChoice("offline", YES_NO_ALIASES, (value) => {
    values.offline = value;
    return value ? "する" : "しない";
  });
  readChoice("iconPlan", ICON_PLAN_ALIASES, (value) => {
    values.iconPlan = value;
    return value === "provisional" ? "暫定で始める" : "用意してから始める";
  });
  readText("themeColor", (value) => {
    const color = value.trim();
    if (!isValidThemeColor(color)) return null;
    values.themeColor = color;
    return color;
  });
  readChoice("changelog", YES_NO_ALIASES, (value) => {
    values.changelog = value;
    return value ? "持つ" : "持たない";
  });
  readChoice("screenshotBypass", YES_NO_ALIASES, (value) => {
    values.screenshotBypass = value;
    return value ? "用意する" : "用意しない";
  });

  // サブドメインとパスは1行なので、「公開URLの取り方」が決まってから振り分ける。
  // 決まっていなければ既定（サブドメイン）に入れる——`emptyNewAppSpec`の既定と同じ
  readText("placement", (value) => {
    const place = compact(value);
    if (place === "") return null;
    if (values.urlMode === "path") {
      values.basePath = place;
      return `${place}（パス）`;
    }
    values.subdomain = place;
    return `${place}（サブドメイン）`;
  });

  // アプリ名が空欄でも、見出しがあればそれを使う（雛形の`# <構想の名前>`は`null`になっている）
  if (values.displayName === undefined && title !== null) {
    values.displayName = title;
    add("displayName", title);
    const index = undecided.indexOf(FIELD_LABELS.displayName);
    if (index >= 0) undecided.splice(index, 1);
  }
  // 概要が空欄なら「一言でいうと」で埋める
  if (values.summary === undefined) {
    const oneLiner = findOneLiner(markdown);
    if (oneLiner !== null) {
      values.summary = oneLiner;
      add("summary", oneLiner);
      const index = undecided.indexOf(FIELD_LABELS.summary);
      if (index >= 0) undecided.splice(index, 1);
    }
  }

  return {
    title,
    state,
    hasSpecTable: rows !== null,
    values,
    filled,
    undecided,
    unreadable,
  };
}

/**
 * 読み取れた値をウィザードの状態へ重ねる。**読めなかった項目は今の値のまま残す。**
 *
 * DB名だけは、種別がDBを使うのに構想メモで決まっていない場合にリポジトリ名から補う
 * （ウィザードの入力欄と同じ導出。`BasicStep`のリポジトリ名の変更と揃える）。
 */
export function applyIdeaImport(spec: NewAppSpec, values: Partial<NewAppSpec>): NewAppSpec {
  const next: NewAppSpec = { ...spec, ...values };
  const profile = newAppKindProfile(next.kind);
  if (!profile.usesDatabase) {
    next.databaseName = null;
  } else if (!next.databaseName && next.repositoryName) {
    next.databaseName = databaseNameFor(next.repositoryName);
  }
  if (next.urlMode === "subdomain" && !next.subdomain) {
    next.subdomain = next.repositoryName;
  }
  if (next.urlMode === "path" && !next.basePath) {
    next.basePath = next.repositoryName;
  }
  return next;
}
