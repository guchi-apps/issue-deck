/**
 * 計画本文に埋め込まれたアーティファクトのHTMLを取り出す（#2200）。**DBにもファイルにも触らない。**
 *
 * **Plan modeでエージェントが書けるのは計画ファイルだけ**（Claude Code 2.1.241のplan mode
 * リマインダに`Read-only except plan file (…)`と明記されている。プロトタイプの案内も
 * 「the prototype is built after plan mode ends, never during it」と言う）。そのため、計画の
 * 承認を待っている間にユーザーが見た目の直しを求めても、**アーティファクトのHTMLファイルを
 * 書き換える経路がどこにも無かった**（#2110では「Plan mode中は差し替えず、承認後に再公開する」
 * という手順で凌いでいた）。
 *
 * そこで**書ける唯一のファイルである計画ファイルの中にHTMLを置く**。`ExitPlanMode`の
 * `PreToolUse`フックは計画ファイルの中身をそのまま送ってくる（`scripts/session-notify.sh`の
 * `resolve_plan_text`）ので、ここで取り出して既存のアーティファクト
 * （`session-artifacts.ts`の`saveSessionArtifact`）として保存すれば、
 * 「修正を送る」→ 計画を出し直す、の1往復で画面の見た目が入れ替わる。
 *
 * **Plan modeの制約は破らない。** エージェントが書き換えるのは計画ファイルだけで、
 * HTMLファイルを書く許可を足したり、フックで書き込みを通したりはしていない。
 *
 * 画面のコンポーネントからimportされる可能性を考えて、ここもPrisma・Node.js専用のものを
 * 引き込まない（`session-artifact.ts`と同じ方針）。
 */

import {
  parseSessionArtifactHtml,
  parseSessionArtifactSourcePath,
} from "@/lib/dispatch/session-artifact";

/**
 * 計画本文の中でHTMLを囲むフェンスの情報文字列。**`html`ではなく`artifact`にする** —
 * 計画には説明のためのHTML片が入ることがあり、`html`を合図にすると巻き添えで取り込む。
 */
const FENCE_INFO = "artifact";

/** 開くフェンスの行（バッククォート3つ以上＋`artifact`）。HTMLに```が入る場合に備えて長さは可変 */
const FENCE_OPEN_PATTERN = new RegExp(`^[ \\t]*(\`{3,})[ \\t]*${FENCE_INFO}[ \\t]*$`, "i");

/**
 * 差し替え先のファイルパスを添える行。**`Artifact`ツールで公開したときと同じパスを書いてもらう**
 * ため、同じIssueの同じ`sourcePath`として保存でき、カードが2枚に増えない
 * （`saveSessionArtifact`は`sourcePath`のハッシュで上書き先を決める）。
 */
const SOURCE_PATH_PATTERN = /^[ \t]*<!--[ \t]*artifact:[ \t]*(.+?)[ \t]*-->[ \t]*$/i;

/** 取り除いたHTMLの跡に残す1行。**見出しの下が空になるのを防ぐ**（計画の体裁が崩れる） */
export const PLAN_ARTIFACT_PLACEHOLDER =
  "（アーティファクトのHTMLはissue-deckが取り込みました。Issue詳細の「アーティファクト」カードで見られます）";

export type PlanArtifact = {
  html: string;
  /** 埋め込みに添えられていた差し替え先のパス。無ければ`null`（呼び出し側が既定を決める） */
  sourcePath: string | null;
};

/**
 * 計画本文からアーティファクトのHTMLを取り出し、本文からは取り除く。
 *
 * **見つからない・壊れているときは計画本文をそのまま返す**（`artifact`は`null`）。
 * この機能が効かないことよりも、計画がIssueに残らないことの方が損失が大きい。
 *
 * - 閉じていないフェンスは**触らない**。途中で切れた本文をHTMLとして保存しても意味が無く、
 *   計画の後半をまるごと削ってしまう
 * - 中身が空・上限超過のものも触らない（判定は`parseSessionArtifactHtml`と共有する）
 * - 拾うのは**最初の1つだけ**。複数置かれた場合に「どれが今の見た目か」を決められない
 */
export function splitPlanArtifact(plan: string): { plan: string; artifact: PlanArtifact | null } {
  const lines = plan.split("\n");

  let openIndex = -1;
  let fenceLength = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const matched = FENCE_OPEN_PATTERN.exec(lines[i]);
    if (matched) {
      openIndex = i;
      fenceLength = matched[1].length;
      break;
    }
  }
  if (openIndex < 0) return { plan, artifact: null };

  const closePattern = new RegExp(`^[ \\t]*\`{${fenceLength},}[ \\t]*$`);
  let closeIndex = -1;
  for (let i = openIndex + 1; i < lines.length; i += 1) {
    if (closePattern.test(lines[i])) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0) return { plan, artifact: null };

  const html = parseSessionArtifactHtml(lines.slice(openIndex + 1, closeIndex).join("\n"));
  if (!html) return { plan, artifact: null };

  // パスの行はフェンスの手前にある想定。**いちばん近いものを採る**（計画の別の場所で
  // 手順として同じ書式を引用していることがあるため）
  let sourcePathIndex = -1;
  let sourcePath: string | null = null;
  for (let i = openIndex - 1; i >= 0; i -= 1) {
    const matched = SOURCE_PATH_PATTERN.exec(lines[i]);
    if (!matched) continue;
    const parsed = parseSessionArtifactSourcePath(matched[1]);
    if (parsed) {
      sourcePathIndex = i;
      sourcePath = parsed;
    }
    break;
  }

  const rest = lines.filter((_, index) => {
    if (index === sourcePathIndex) return false;
    return index < openIndex || index > closeIndex;
  });
  rest.splice(sourcePathIndex >= 0 ? openIndex - 1 : openIndex, 0, PLAN_ARTIFACT_PLACEHOLDER);

  return { plan: rest.join("\n").trim(), artifact: { html, sourcePath } };
}

/**
 * パスが添えられていなかったときの保存先キー。
 *
 * **実在するファイルのパスではない。** `saveSessionArtifact`が同一判定に使うだけの文字列で、
 * issueごとに1つに定まればよい。ここが実在パスと衝突しないよう、`plan-artifact:`で始める。
 */
export function defaultPlanArtifactSourcePath(
  repositoryFullName: string,
  issueNumber: number,
): string {
  return `plan-artifact:${repositoryFullName}#${issueNumber}`;
}
