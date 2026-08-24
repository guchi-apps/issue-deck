/**
 * 立ち上げが作ったIssueを、**後から来たエージェントが機械的に見分けられるようにする**（#2250）。
 *
 * `aide-bot`の立ち上げでは、同じ「vhostを作って公開する」作業のIssueが`guchi-apps/vps`へ
 * 4件並んだ（`#121`＝立ち上げが起票・`#122`＝別セッションが起票・`#124`＝手作業Issue・
 * `#128`＝デプロイ失敗の調査から起票）。後から入ったエージェントが既存のIssueを見つけられず、
 * 起票し直したことが原因。
 *
 * 対策は2つで、どちらもここに置く。
 *
 * - **本文の先頭へ不可視のマーカーを埋める**（`deploy-failure.ts`と同じやり方）。
 *   GitHubのIssue検索は**HTMLコメントの中身も索引している**ので、
 *   `gh issue list --repo guchi-apps/vps --state open --search "new-app-launch aide-bot"`
 *   で引ける。人が読む本文は変わらない。
 * - **起票の前に、対象リポジトリのopenなIssueから同じ対象のものを探す。**
 *   見つかったら新しく作らず、そのIssueへコメントする（`POST /api/new-app`）。
 *
 * **判定は「見つけたら起票しない」側へ倒す。** 取りこぼして重複するより、既存Issueへ
 * コメントが1件増える方が安い（人が読めば同じ対象かどうかは分かる）。
 */

import type { NewAppArtifactKind } from "@/lib/new-app/plan";

/** 検索に使う語。**変えると過去に起票したIssueが引けなくなる。** */
export const NEW_APP_MARKER_TAG = "new-app-launch";

const MARKER_PREFIX = `<!-- ${NEW_APP_MARKER_TAG}:`;

/** 立ち上げが作ったIssueの本文に埋める印。1行のJSONにする（改行を含められないため） */
export type NewAppLaunchMarker = {
  /** リポジトリ名（`aide-bot`）。検索語にもなる */
  app: string;
  /** `guchi-apps/aide-bot` */
  repo: string;
  /** 公開するホスト名（`aide-bot.gucchii.com`）。決まっていなければ空文字 */
  host: string;
  /** どの作成物か */
  kind: NewAppArtifactKind;
  /** 立ち上げの親Issue（`guchi-apps/issue-deck#2213`）。親Issue自身は空文字 */
  parent: string;
};

export function buildNewAppMarker(marker: NewAppLaunchMarker): string {
  return `${MARKER_PREFIX} ${JSON.stringify(marker)} -->`;
}

/** 本文の先頭へマーカーを置く。**すでに入っていれば足さない**（押し直しで二重にしない） */
export function withNewAppMarker(body: string, marker: NewAppLaunchMarker): string {
  if (body.includes(MARKER_PREFIX)) return body;
  return `${buildNewAppMarker(marker)}\n\n${body}`;
}

/**
 * 本文からマーカーを読み出す。**立ち上げが作ったIssueでなければ`null`。**
 *
 * 壊れたJSON・形の合わない値は「マーカー無し」として扱う（人が本文を編集して壊すことがあり、
 * そのときに重複判定が例外で落ちるより、印が無いものとして扱う方がよい）。
 */
export function parseNewAppMarker(body: string | null | undefined): NewAppLaunchMarker | null {
  if (!body) return null;
  const start = body.indexOf(MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf("-->", start);
  if (end === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start + MARKER_PREFIX.length, end).trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const marker = parsed as Record<string, unknown>;
  if (typeof marker.app !== "string" || typeof marker.repo !== "string") return null;

  return {
    app: marker.app,
    repo: marker.repo,
    host: typeof marker.host === "string" ? marker.host : "",
    kind: (typeof marker.kind === "string" ? marker.kind : "vps-issue") as NewAppArtifactKind,
    parent: typeof marker.parent === "string" ? marker.parent : "",
  };
}

/** 重複を探す相手。GitHubのIssue1件ぶん（openのものだけを渡す） */
export type ExistingIssue = {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
};

/** 同じ対象を指していると判断した既存Issue */
export type ExistingLaunchIssue = {
  number: number;
  title: string;
  url: string;
  /** `guchi-apps/vps#121` */
  reference: string;
  /** なぜ同じ対象だと判断したか。画面と警告文にそのまま出す */
  reason: ExistingLaunchIssueReason;
};

export type ExistingLaunchIssueReason =
  /** 立ち上げが埋めたマーカーが一致した */
  | "marker"
  /** ホスト名が本文かタイトルに出てくる */
  | "hostname"
  /** リポジトリ名（アプリ名）がタイトルに出てくる */
  | "app-name";

export const EXISTING_LAUNCH_ISSUE_REASON_LABELS: Record<ExistingLaunchIssueReason, string> = {
  marker: "同じ立ち上げが起票した印が入っています",
  hostname: "同じホスト名を指しています",
  "app-name": "同じアプリ名がタイトルに入っています",
};

export type FindExistingLaunchIssueInput = {
  /** 探す先（`guchi-apps/vps`） */
  targetRepository: string;
  /** 立ち上げるアプリのリポジトリ名（`aide-bot`） */
  appName: string;
  /** 公開するホスト名。**サブドメインのときだけ渡す**——`gucchii.com`のような共有の
   *  ホスト名で照合すると、そのホストに関わるIssueがすべて当たってしまう */
  hostname: string | null;
};

/**
 * openなIssueの中から、この立ち上げと同じ対象を指しているものを1件返す。
 *
 * **番号の小さい（古い）ものを優先する。** 重複の元になった1件目へ集約したいため。
 * 判定の強さは マーカー > ホスト名 > アプリ名 の順で、強い理由が1件でもあれば
 * そちらを返す。
 */
export function findExistingLaunchIssue(
  issues: ExistingIssue[],
  input: FindExistingLaunchIssueInput,
): ExistingLaunchIssue | null {
  const ordered = [...issues].sort((a, b) => a.number - b.number);
  const found: Partial<Record<ExistingLaunchIssueReason, ExistingLaunchIssue>> = {};

  for (const issue of ordered) {
    const reason = matchReason(issue, input);
    if (reason === null) continue;
    if (found[reason]) continue;
    found[reason] = {
      number: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      reference: `${input.targetRepository}#${issue.number}`,
      reason,
    };
  }

  return found.marker ?? found.hostname ?? found["app-name"] ?? null;
}

function matchReason(
  issue: ExistingIssue,
  input: FindExistingLaunchIssueInput,
): ExistingLaunchIssueReason | null {
  const marker = parseNewAppMarker(issue.body);
  if (marker && marker.app === input.appName) return "marker";

  const haystack = `${issue.title}\n${issue.body ?? ""}`;
  if (input.hostname && containsToken(haystack, input.hostname)) return "hostname";
  // アプリ名はタイトルだけを見る。本文には「他のアプリでは〜」のような言及が入りうる
  if (containsToken(issue.title, input.appName)) return "app-name";
  return null;
}

/** 語として含まれるか。`aide-bot`が`aide-bottle`に当たらないようにする */
function containsToken(text: string, token: string): boolean {
  if (token === "") return false;
  const haystack = text.toLowerCase();
  const needle = token.toLowerCase();
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + needle.length] ?? "";
    if (!isTokenChar(before) && !isTokenChar(after)) return true;
    from = at + 1;
  }
}

function isTokenChar(char: string): boolean {
  return char !== "" && /[0-9a-z_-]/.test(char);
}

/**
 * 既存Issueへ書き足すコメント。**手順を複製しない**——同じ手順が2か所にあると片方が古くなる
 * （#2250の追記で実際に起きた）。ここに書くのは「この立ち上げもこのIssueを待っている」ことだけ。
 */
export function buildExistingLaunchIssueComment(params: {
  displayName: string;
  repositoryFullName: string;
  hostname: string;
  parent: string;
  reason: ExistingLaunchIssueReason;
}): string {
  return `🚀 **${params.displayName}（\`${params.repositoryFullName}\`）の立ち上げも、この作業を待っています。**

issue-deckの画面の「新規アプリを立ち上げる」が同じ対象のIssueを探したところ、このIssueが
見つかったため（${EXISTING_LAUNCH_ISSUE_REASON_LABELS[params.reason]}）、**新しくIssueを作らずにここへ書き足しています。**

- 公開URL: \`${params.hostname}\`
- 立ち上げの親Issue: ${params.parent}

作業の内容が足りていれば、このIssueをそのまま進めてください。足りない場合は、この
Issueへ追記してください（**同じ対象のIssueを新しく立てないでください**）。

${buildNewAppMarker({
  app: params.repositoryFullName.split("/").pop() ?? params.repositoryFullName,
  repo: params.repositoryFullName,
  host: params.hostname,
  kind: "vps-issue",
  parent: params.parent,
})}
`;
}
