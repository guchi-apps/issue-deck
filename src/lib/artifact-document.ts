/**
 * セッションが公開したアーティファクトを、issue-deck自身のオリジンから出すための組み立て（#2154）。
 *
 * **claude.aiのアーティファクトページはiframeに入れられない。** `https://claude.ai/code/artifact/<id>`は
 * `content-security-policy: frame-ancestors 'self'`を返すため、issue-deckから埋め込むと空白になる
 * （実測。中身を出している`<id>.frame.claudeusercontent.com`の方も、トークン付きのパスでしか
 * 開かない）。そこで**公開した時点でHTMLの原本を受け取り**（`PostToolUse(Artifact)`のフック）、
 * ここで包み直して自分のオリジンから配る。
 *
 * **出るのは近似**であって、claude.aiで見えるものと同一ではない。あちらが公開時に足している
 * mermaidの描画とランタイム機能（`window.claude.*`）はここには無い。**その断りは画面に出す**
 * （`issue-artifact-panel.tsx`）。ここで再現するのは、アーティファクトの作り手が前提にしている
 * 「`<!doctype html>`〜`<body>`の外枠」と「最小限のCSSリセット」までにとどめる。
 */

/** アーティファクトのHTMLを配るときのCSP。**`sandbox`が主眼**（後述の`ARTIFACT_IFRAME_SANDBOX`と対）。 */
export const ARTIFACT_CONTENT_SECURITY_POLICY = [
  // アーティファクトのHTMLはエージェントが書いた任意のJSを含む。issue-deckと同じオリジンで
  // 素直に出すと、そのJSからissue-deckのCookie・localStorageへ手が届く。**`sandbox`指定で
  // 不透明なオリジンへ落とす**ことで、スクリプトは動くがオリジンの資源には触れなくなる。
  // レスポンスヘッダにも置くのは、iframeを介さずURLを直接開かれた場合にも効かせるため。
  "sandbox allow-scripts allow-popups allow-forms allow-modals",
  // claude.aiが許しているのはGoogle Fontsだけ（アーティファクトの作り手はそれを前提に書く）。
  // 他所への通信は塞ぐ——アーティファクトは自己完結しているのが約束で、通信が要るものは無い。
  "default-src 'self' data: blob:",
  "style-src 'unsafe-inline' https://fonts.googleapis.com data:",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "connect-src 'none'",
  // ページの中で`srcdoc`のiframeを使う見た目案があるため、**同一オリジン相当は通す**。
  // sandboxで不透明なオリジンへ落ちているので、ここを開けても外へは出られない
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * アーティファクトを出すiframeの`sandbox`属性。
 *
 * **`allow-same-origin`は絶対に足さない。** 足すと不透明なオリジンではなくなり、
 * アーティファクトのJSからissue-deckのCookie・localStorageが読めてしまう。
 */
export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";

/** claude.aiのアーティファクトURLの形。`/code/artifact/<id>`と、公開ページの`/public/artifacts/<id>`。 */
const ARTIFACT_URL_PATTERN =
  /^https:\/\/claude\.ai\/(?:code\/artifact|public\/artifacts)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#].*)?$/;

/**
 * claude.aiのアーティファクトURLからIDを取り出す。**形が違えば`null`**。
 *
 * 本文・コメントの中のリンクをアプリ内プレビューへ差し替えるとき（`markdown-body.tsx`）と、
 * フックから受け取ったURLを覚えるときの両方で使う。
 */
export function parseArtifactUrlId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ARTIFACT_URL_PATTERN.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * claude.aiが公開時に当てているCSSリセットの代替。**同一ではないが、アーティファクトの
 * 作り手が前提にしている最小限**（`box-sizing`・余白のリセット・画像の追従）を揃える。
 *
 * `body`の背景を塗らないのは、アーティファクト側が自分で塗る約束になっているため。
 * 塗っていないアーティファクトのために、`color-scheme`だけ渡してブラウザの既定に任せる。
 */
const ARTIFACT_RESET_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
img,svg,video,canvas{max-width:100%;height:auto}
h1,h2,h3,h4,p,figure,blockquote,dl,dd{margin:0}
button,input,select,textarea{font:inherit;color:inherit}`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 受け取ったHTMLが、すでに完全な文書（`<!doctype>`か`<html>`で始まる）かどうか。 */
function isFullDocument(html: string): boolean {
  return /^\s*(<!doctype\s|<html[\s>])/i.test(html);
}

/**
 * 保存してあるHTMLの断片を、そのまま表示できる1枚の文書へ包む。
 *
 * **すでに完全な文書ならそのまま返す。** アーティファクトの約束（`<!doctype>`・`<html>`・
 * `<head>`・`<body>`を自分では書かない）を破ったHTMLでも、二重に包んで壊すよりは
 * 書いたとおりに出す方がまだ読める。
 */
export function buildArtifactDocument({ html, title }: { html: string; title: string }): string {
  if (isFullDocument(html)) return html;

  // **`data-theme`は立てない。** issue-deck自身がOSの設定（`prefers-color-scheme`）だけで
  // 明暗を決めており、アーティファクトも同じ約束で書かれている。ここで片方に固定すると、
  // アーティファクト側が`:root:not([data-theme="light"])`のような形で分けている配色が効かない
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${ARTIFACT_RESET_CSS}</style>
</head>
<body>
${html}
</body>
</html>
`;
}
