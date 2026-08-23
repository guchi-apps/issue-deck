/**
 * アーティファクトを別ウィンドウで開くための組み立て（#2210）。
 *
 * アプリ内の重ね表示（`artifact-preview.tsx`）はIssueの本文・コメントを覆うため、見た目案と
 * 計画・指摘を見比べられない。**単独ページ（`/artifacts/<id>`）を別ウィンドウで開けるように**
 * して、デッキを見ながらアーティファクトを開いたままにできるようにする。
 *
 * 組み立ては`issue-create-window.ts`（#1728）に倣う。あちらと違って渡す状態が無いので、
 * localStorageを介した受け渡しは要らない。
 */

/** 単独ページのURL。**別ウィンドウとリンクの`href`の両方がここを通る**（形を1か所に持つ）。 */
export function artifactWindowPath(id: string): string {
  return `/artifacts/${encodeURIComponent(id)}`;
}

/**
 * 開くウィンドウの名前。**アーティファクトごとに分ける。**
 *
 * `issue-create-window.ts`は固定名で1枚を使い回している（作成フォームは1つしか要らない）が、
 * こちらは2つの見た目案を並べて見比べる使い方があるため、別のアーティファクトなら別の
 * ウィンドウにする。同じものを2回押したときだけ、既に開いているウィンドウが前に出る。
 */
export function artifactWindowName(id: string): string {
  return `issue-deck-artifact-${id}`;
}

/** アーティファクトはPC幅の見た目を主に持つ（サムネイルを1200px幅で描かせているのと同じ前提）。 */
const WINDOW_WIDTH = 1180;
const WINDOW_HEIGHT = 900;

/**
 * `window.open`へ渡すウィンドウ設定を作る。画面の中央に、画面からはみ出さない大きさで開く。
 * `popup`を付けないとタブとして開くブラウザがあるため、常に付ける。
 */
export function buildArtifactWindowFeatures(screen: {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
}): string {
  const width = Math.min(WINDOW_WIDTH, Math.max(320, screen.availWidth - 40));
  const height = Math.min(WINDOW_HEIGHT, Math.max(400, screen.availHeight - 40));
  const left = Math.round((screen.availLeft ?? 0) + (screen.availWidth - width) / 2);
  const top = Math.round((screen.availTop ?? 0) + (screen.availHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * 別ウィンドウで開く。**開けたかどうかを返す**（ポップアップブロック時はfalse）。
 *
 * 呼び出し側は`<a href={artifactWindowPath(id)} target="_blank">`の`onClick`から呼び、
 * **開けたときだけ`preventDefault`する**。開けなければリンクのまま別タブが開くので、
 * ポップアップを止めているブラウザでも「押しても何も起きない」にはならない。
 */
export function openArtifactWindow(id: string): boolean {
  const opened = window.open(
    artifactWindowPath(id),
    artifactWindowName(id),
    buildArtifactWindowFeatures(window.screen),
  );
  if (!opened) return false;
  opened.focus();
  return true;
}
