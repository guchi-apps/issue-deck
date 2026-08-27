/**
 * 本文の末尾に並ぶ画像記法（`![alt](url)`）を「添付」として出し入れする（#1819）。
 *
 * **元は`mention-textarea.tsx`の中にあった**が、計画への修正送信でも画像を添付できるように
 * したとき（#2425）、サーバー側（`session-plan-request.ts`）からも同じ切り分けが要るように
 * なったのでここへ移した。あちらは`"use client"`のコンポーネントで、APIルートから読むと
 * Reactとアイコンを丸ごと引き込んでしまう。
 *
 * 呼び出し元へ渡す値は**画像記法込みの1本の文字列**のままにし、分解・合成はここに閉じる。
 */

/** 入力欄の下にサムネイルとして並べる、添付済みの画像1枚ぶん */
export type ImageAttachment = {
  /** 画像記法のalt。アップロードしたファイル名が入る */
  name: string;
  url: string;
};

/** 単独の行がまるごと画像記法（`![alt](url)`）になっているかどうか */
const ATTACHMENT_LINE_PATTERN = /^!\[([^\]]*)\]\(([^()\s]+)\)$/;

/** 本文のどこかに画像記法があるか（行まるごとでなくてもよい） */
const INLINE_IMAGE_PATTERN = /!\[[^\]]*\]\([^()\s]+\)/;

/**
 * 本文の末尾に並ぶ画像記法を「添付」として切り出す（#1819）。
 *
 * 添付は常に末尾へ足すため、末尾から空行を読み飛ばしつつ画像記法だけの行を集め、
 * それ以外の行が現れた時点で打ち切る。**文章の途中に書かれた画像記法は本文の文字として
 * そのまま残す**——過去の下書きや既存コメントには文中に画像を置いたものがあり、
 * それらを勝手に末尾へ動かすと編集で本文が書き換わってしまうため。
 */
export function splitAttachments(value: string): { body: string; attachments: ImageAttachment[] } {
  const lines = value.split("\n");
  const attachments: ImageAttachment[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === "") {
      end -= 1;
      continue;
    }
    const match = ATTACHMENT_LINE_PATTERN.exec(line);
    if (!match) break;
    attachments.unshift({ name: match[1], url: match[2] });
    end -= 1;
  }
  if (attachments.length === 0) return { body: value, attachments: [] };
  return { body: lines.slice(0, end).join("\n").replace(/\s+$/, ""), attachments };
}

/** `splitAttachments`の逆。本文と添付から、呼び出し元へ渡す1本の文字列を組み立てる */
export function composeAttachments(body: string, attachments: ImageAttachment[]): string {
  // 添付が無いときに本文へ手を入れると、末尾の改行が消えて入力の邪魔になる。
  if (attachments.length === 0) return body;
  const block = attachments.map(({ name, url }) => `![${name}](${url})`).join("\n");
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? block : `${trimmed}\n\n${block}`;
}

/** 画像記法を1つでも含むか。**末尾の添付だけでなく文中のものも見る**（#2425） */
export function hasImageMarkdown(value: string): boolean {
  return INLINE_IMAGE_PATTERN.test(value);
}
