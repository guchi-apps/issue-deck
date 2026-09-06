import { splitShellCommandLines } from "@/lib/shell-command-lines";

/** フェンス付きコードブロック（言語指定は問わない）を取り出す */
const FENCE_PATTERN = /```[^\n`]*\n([\s\S]*?)```/g;

export type QuestionCommandBlocks = {
  /** フェンスを取り除いた地の文（前後の空白を詰めたもの） */
  text: string;
  /** フェンスの中身を実行単位まで分割したコマンドの一覧（複数フェンスがあれば順につなげる） */
  commands: string[];
};

/**
 * 質問文（`AskUserQuestion`の`question`）に埋め込まれたフェンス付きコードブロックを、
 * 独立したコマンドとして取り出す（#2818）。
 *
 * `question.question`はMarkdownとして描画していないプレーンテキストの1文想定だが、実際には
 * 実行の確認を取るために``` bash ``` のフェンスを埋め込んで書かれることがある。そのまま
 * `<p>`へ出すとバッククォートが文字どおり表示され、改行も潰れて1行に読める（Issue #2818の
 * 添付スクリーンショットで確認した実例）。ここではフェンスの中身だけを取り出し、地の文とは
 * 別に独立した一覧として描けるようにする。
 */
export function extractQuestionCommandBlocks(question: string): QuestionCommandBlocks {
  const commands: string[] = [];
  const text = question
    .replace(FENCE_PATTERN, (_match, body: string) => {
      commands.push(...splitShellCommandLines(body));
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { text, commands };
}
