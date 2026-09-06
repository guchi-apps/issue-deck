import type { SessionQuestion } from "@/lib/dispatch/session-question-request";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  extractShellBlock,
  findInteractiveCommand,
  findPlaceholder,
} from "@/lib/manual-step-command";
import {
  parseManualStepGuide,
  resolveManualStepDevice,
  type ManualStepGuide,
  type ManualStepGuideStep,
} from "@/lib/manual-step-guide";
import type { IssueLabel } from "@/types/issue";

/**
 * 手作業セッション（#2771）の質問が、本文のどの手順のことを聞いているのかを当てる（#2820）。
 *
 * 手作業Issueをセッションで進めると、代行できない手順（ブラウザ・VPS・埋める値を含むもの）で
 * 「手順1「…」は代行できません。実施されましたか？」と聞かれる。**答えるのに必要な
 * 「何をどこで実行するのか」は本文にあるのに、質問パネルには出ていなかった**——Issue詳細は
 * 手順を並べない方針（`manual-step-panel.tsx`）なので、本文を読みに画面の下まで下がることになる。
 *
 * ここで質問と手順を結び、パネルがその手順の中身をそのまま出せるようにする。
 *
 * **質問と手順を結ぶデータは無い**（`AskUserQuestion`の引数はモデルが書いた文字列そのまま）。
 * そのため照合は質問文の文字列で行う——「この質問の前提」（`question-premise.ts`）が
 * 「エージェントが書いた最新のコメント」でしかないのと同じ制約で、断定はできない。
 * **当たらなければ`null`を返してカードごと出さない。** 関係のない手順を出す方が害が大きい
 * （読んだ人はその手順を実行してしまう）。
 *
 * 照合しやすい質問文の形は`scripts/prompts/manual-step-agent.md`が指定している。
 * それでも書き方が揺れることはあるので、**手順番号と手順名の2通りで当てる**。
 */

/** 質問が指している手順。パネルへ渡す形 */
export type ManualStepQuestionGuide = {
  /** 何番目の手順か（1始まり） */
  order: number;
  /** 本文の手順の総数 */
  total: number;
  step: ManualStepGuideStep;
  where: ManualStepGuide["where"];
  /**
   * この手順を実行する端末（`resolveManualStepDevice`で解決済み）。
   * **画面はこの値だけを見る**——`where.device`を読み直すと手順ごとの端末が案内できなくなる。
   */
  device: string | null;
  /** 本文に書かれたコマンド（`<…>`が入ったまま）。ちょうど1つのときだけ。無ければ`null` */
  command: string | null;
  /**
   * このコマンドを代行できない理由（対話が要る・値を埋める箇所がある）。無ければ`null`。
   * **プレーンな文章**で返す（`ManualStepWhereToRun`の`reason`はMarkdownとして描かない）。
   */
  reason: string | null;
};

/**
 * 質問が指している手順を返す。当たらなければ`null`。
 *
 * 質問が複数ある場合は、**当たった最初の質問**の手順を返す（1回の`AskUserQuestion`で
 * 別々の手順を聞くことは想定していない）。
 */
export function findManualStepForQuestion({
  labels,
  body,
  questions,
}: {
  labels: IssueLabel[];
  body: string | null;
  questions: readonly SessionQuestion[];
}): ManualStepQuestionGuide | null {
  if (!isManualStepIssue(labels)) return null;

  const guide = parseManualStepGuide(body);
  // `hasTemplate`でない本文は節全体が1手順として返るため、「手順N」と結び付けようがない
  if (!guide.hasTemplate || guide.steps.length === 0) return null;

  for (const question of questions) {
    const index = findStepIndex(guide.steps, question);
    if (index === null) continue;

    const step = guide.steps[index];
    const command = extractShellBlock(step.markdown);
    return {
      order: index + 1,
      total: guide.steps.length,
      step,
      where: guide.where,
      device: resolveManualStepDevice(guide.where, step),
      command,
      reason: describeReason(command),
    };
  }
  return null;
}

/** 質問文（と`header`）から手順の位置を当てる。番号 → 手順名の順で見る */
function findStepIndex(steps: ManualStepGuideStep[], question: SessionQuestion): number | null {
  const byNumber = matchStepNumber(`${question.header} ${question.question}`, steps.length);
  if (byNumber !== null) return byNumber;
  return matchStepTitle(steps, question.question);
}

/**
 * 「手順3」のような番号で当てる。**最初に現れたものだけ**を見る。
 *
 * 手順の総数を超える番号は当たらないものとして扱う（`## 完了の確認方法`を「手順5」と
 * 呼んだ質問で、末尾の手順を出してしまわないようにする）。
 */
function matchStepNumber(text: string, total: number): number | null {
  const found = /手順\s*([0-9０-９]{1,2})/.exec(text);
  if (!found) return null;
  const order = Number(toHalfWidthDigits(found[1]));
  if (!Number.isInteger(order) || order < 1 || order > total) return null;
  return order - 1;
}

/**
 * 「手順名」の引用で当てる。番号が書かれていない質問のための2本目。
 *
 * **短い引用は見ない**（`「実行する」`のような選択肢の引用で当たってしまう）。質問文の中では
 * 手順名が省略されることがある（`「…を作成し…」`）ので、**前方一致で見る**。
 */
function matchStepTitle(steps: ManualStepGuideStep[], question: string): number | null {
  const quoted = [...question.matchAll(/[「『]([^」』]+)[」』]/g)].map((match) =>
    normalizeTitle(match[1]),
  );
  for (const needle of quoted) {
    if (needle.length < MIN_TITLE_LENGTH) continue;
    const index = steps.findIndex((step) => {
      const text = normalizeTitle(step.text);
      if (text.length < MIN_TITLE_LENGTH) return false;
      return text.startsWith(needle) || needle.startsWith(text);
    });
    if (index !== -1) return index;
  }
  return null;
}

/** これより短い引用では手順を特定しない（選択肢の文言と区別が付かない） */
const MIN_TITLE_LENGTH = 8;

/** 照合用に、空白・強調記号・末尾の省略記号を落とす */
function normalizeTitle(value: string): string {
  return value.replace(/[\s　`*_]/g, "").replace(/[.。…]+$/, "");
}

function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xfee0));
}

/**
 * 代行できない理由を1行で返す。**判定は既存の関数をそのまま呼ぶ**——ここに条件を書き足すと、
 * 手作業アシスタントが「代行できる」と言っている手順に、質問パネルだけが理由を出すことになる。
 */
function describeReason(command: string | null): string | null {
  const interactive = findInteractiveCommand(command);
  if (interactive !== null) {
    return `「${interactive}」のように対話が要るコマンドを含むため代行できません。このブロックはまとめて手元で実行してください。`;
  }
  const placeholder = findPlaceholder(command);
  if (placeholder !== null) {
    return `「${placeholder}」のように値を埋める箇所があるため代行できません。値を埋めてから実行してください。`;
  }
  return null;
}
