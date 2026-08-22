/**
 * セッションが公開したアーティファクト（#2154）のうち、**DBにもファイルにも触らない部分**。
 *
 * 受け取ってよい値の形・見出しの決め方・画面へ渡す形を持つ。保存と取り出しは
 * `session-artifacts.ts`。`session-plan-request.ts`と`plan-requests.ts`の分け方に揃えてある
 * （このファイルは画面のコンポーネントからもimportされるので、Prismaを引き込まない）。
 */

/**
 * 受け取るHTMLの上限。見た目案のアーティファクトは画像をdata URIで埋めるため数百KBになるが、
 * それでもこの線には遠い。**明らかに壊れた入力でディスクを埋めないための線**として置く。
 */
export const SESSION_ARTIFACT_HTML_LIMIT = 2 * 1024 * 1024;

/**
 * 1つのIssueで保持する件数の上限。超えた分は古いものから消す。
 *
 * **履歴として貯める場所ではない。** 見たいのは今の見た目で、過去の版はclaude.ai側に残る。
 */
export const SESSION_ARTIFACT_PER_ISSUE_LIMIT = 20;

/** 見出しの最大長。カード1行に収まらない長さは画面側で省略されるので、DBに入る前に切る。 */
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 1000;

/** 画面へ渡す1件。**HTMLの中身は含めない**（配信は`/api/issues/artifacts/<id>`が受け持つ）。 */
export type SessionArtifactView = {
  id: string;
  title: string;
  description: string | null;
  favicon: string | null;
  /** claude.aiのURL。アプリ内の表示が崩れたときの逃げ道として画面に出す */
  claudeUrl: string | null;
  /** claude.aiのアーティファクトID。本文中のリンクと突き合わせるために持つ */
  claudeArtifactId: string | null;
  hostName: string | null;
  byteSize: number;
  publishedAt: string;
};

/**
 * アーティファクトのHTML。**空は受け取らない**（中身の無いカードが増えるだけ）。
 * 上限を超えたものも受け取らず、フック側は諦めて何もしない（セッションは止めない）。
 */
export function parseSessionArtifactHtml(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  // `Buffer`を使わない。**このファイルは画面のコンポーネントからもimportされる**ので、
  // Node.js専用のものを混ぜるとブラウザ側で落ちる
  if (new TextEncoder().encode(value).length > SESSION_ARTIFACT_HTML_LIMIT) return null;
  return value;
}

/**
 * フックが読んだHTMLファイルのパス。**再公開の同一判定に使う唯一の手掛かり**なので、
 * 空だけを弾いて中身は問わない（worktreeの外を指していても、こちらは読みに行かない）。
 */
export function parseSessionArtifactSourcePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  return trimmed;
}

/** 見出し・説明のような短い文字列。長すぎるものは切って通す（受け取り自体は拒否しない）。 */
function parseShortText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

export function parseSessionArtifactTitle(value: unknown): string | null {
  return parseShortText(value, TITLE_LIMIT);
}

export function parseSessionArtifactDescription(value: unknown): string | null {
  return parseShortText(value, DESCRIPTION_LIMIT);
}

/**
 * タブのアイコンに使う絵文字。**絵文字かどうかまでは見ない**（判定を持つほどの価値が無い）。
 * 長い文字列がアイコンの位置に流れ込まないよう、長さだけで切る。
 */
export function parseSessionArtifactFavicon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 8) return null;
  return trimmed;
}

/**
 * カードに出す見出しを決める。**HTMLの`<title>` → フックが送ってきた見出し → ファイル名**の順。
 *
 * claude.aiの並び順に合わせてある——`title`引数は「HTMLに`<title>`が無いときだけ効く」もので、
 * 逆順にすると画面のカードとclaude.ai側で違う名前が出る。フック側でHTMLを解釈させない
 * （shellにHTMLを読ませない）ため、`<title>`を読むのはここが唯一の場所。
 */
export function resolveSessionArtifactTitle(params: {
  title: string | null;
  html: string;
  sourcePath: string;
}): string {
  const match = /<title[^>]*>([\s\S]{1,500}?)<\/title>/i.exec(params.html);
  const fromHtml = match ? parseSessionArtifactTitle(decodeBasicEntities(match[1])) : null;
  if (fromHtml) return fromHtml;
  if (params.title) return params.title;

  const basename = params.sourcePath.split("/").pop() ?? params.sourcePath;
  return parseSessionArtifactTitle(basename.replace(/\.html?$/i, "")) ?? "アーティファクト";
}

/** `<title>`に入りうる最小限の実体参照だけを戻す。表示用の見出しなので、これで足りる。 */
function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
