/**
 * 手作業アシスタントで想定外のことが起きたときの、記録の形（#2299）。
 *
 * 代行実行の失敗は終了コードと出力が画面に届くので、原因を調べて直せる（#1869）。
 * けれど**手作業の多くは代行できない**——ブラウザでの操作、メインPC・VPSでの作業、
 * 値を埋めてから実行するコマンドは、どれも人が自分で実行する。そこで
 * 「コマンドの出力が手順書と違う」「外部ツールの画面が手順書と違う」が起きても、
 * 画面に押せるものは「実行した・次へ」か「あとで」しか無く、気付いたことはどこにも残らない。
 * 手順書は実態とずれたまま次の人へ渡る。
 *
 * ここでは**Issueコメントを記録の置き場**にする。新しいテーブルもラベルも増やさない。
 *
 * - **貼り付けた出力・画面の文言はコメントへ入れない。** このリポジトリはPUBLICで、
 *   手作業の出力にはシークレットが混ざりうる（#1869で「本文へ入るのはコマンドだけ」と
 *   決めたのと同じ線引き）。Issueに残るのは分類・自由記述・どの手順かの3つだけ
 * - **`00.check-user`は付けない。** 手作業Issueには承認して再開させる相手が居ない
 *   （CLAUDE.md「手作業Issueには`00.check-user`を付けない」）。気付く経路はIssueの
 *   コメント欄と、次に同じ手作業を開いた人の最初の画面
 */

/** 記録コメントの目印。画面はこれが付いたコメントだけを読み直す */
export const MANUAL_STEP_TROUBLE_MARKER = "manual-step-trouble";

/**
 * つまずきの分類。**選ばなくても記録できる**（`null`）——分類を必須にすると、
 * どれにも当てはまらないつまずきが書かれずに終わる。
 */
export type ManualStepTroubleCategory = "output" | "display" | "blocked" | "no_change";

export const MANUAL_STEP_TROUBLE_CATEGORIES: {
  value: ManualStepTroubleCategory;
  label: string;
}[] = [
  { value: "output", label: "コマンドの出力が違う" },
  { value: "display", label: "外部ツールの表示が違う" },
  { value: "blocked", label: "手順どおりに実行できない" },
  { value: "no_change", label: "実行したが結果が変わらない" },
];

/** 自由記述の上限。1画面で読める長さに収める */
export const MANUAL_STEP_TROUBLE_DETAIL_MAX_LENGTH = 1000;

/** 貼り付け欄の上限。Claudeへ渡す長さ（`MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH`）に合わせる */
export const MANUAL_STEP_TROUBLE_PASTED_MAX_LENGTH = 4000;

/** 記録に残す手順の見出し。長い手順をコメントの箇条書きへ流し込まないよう切る */
const STEP_TEXT_MAX_LENGTH = 80;

/** 画面が書いて送るつまずきの中身 */
export type ManualStepTroubleReport = {
  category: ManualStepTroubleCategory | null;
  /** 何が起きたか（人が書いた文章） */
  detail: string;
  /**
   * 出力・画面の文言の貼り付け。**Claudeへ送るのは同意があるときだけで、Issueには残さない。**
   * 記録だけを行う場合は空文字でよい
   */
  pasted: string;
};

/** つまずき1件。コメントへ書くときも、コメントから読み直すときもこの形 */
export type ManualStepTroubleRecord = {
  /** `## やること`の手順の通し番号（1始まり）。`## 完了の確認方法`でのつまずきは`null` */
  stepOrder: number | null;
  /** 手順の総数。`stepOrder`が`null`のときは`null` */
  stepCount: number | null;
  /** その手順の見出し（素のテキスト）。読み直したときは記録された文字列そのまま */
  stepText: string;
  category: ManualStepTroubleCategory | null;
  detail: string;
};

export function describeManualStepTroubleCategory(
  category: ManualStepTroubleCategory | null,
): string | null {
  return MANUAL_STEP_TROUBLE_CATEGORIES.find((entry) => entry.value === category)?.label ?? null;
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

/**
 * 記録として投稿するコメントの本文を組み立てる。
 *
 * **末尾の目印に分類と手順番号を持たせる**（`<!-- manual-step-trouble: step=3 category=display -->`）。
 * 読み直すときに箇条書きの表記へ依存しないようにするためで、本文の見た目を後から変えても
 * 過去のコメントを読み続けられる。
 */
export function buildManualStepTroubleComment(record: ManualStepTroubleRecord): string {
  const where =
    record.stepOrder === null
      ? "完了の確認方法"
      : `手順 ${record.stepOrder}${record.stepCount === null ? "" : ` / ${record.stepCount}`}`;
  const categoryLabel = describeManualStepTroubleCategory(record.category);

  const lines = [
    "⚠️ **手作業でつまずきました。**",
    "",
    `- つまずいたところ: ${where}${record.stepText === "" ? "" : `「${truncate(record.stepText, STEP_TEXT_MAX_LENGTH)}」`}`,
  ];
  if (categoryLabel !== null) lines.push(`- 分類: ${categoryLabel}`);
  lines.push(`- 起きたこと: ${truncate(record.detail, MANUAL_STEP_TROUBLE_DETAIL_MAX_LENGTH)}`);
  lines.push(
    "",
    "実行時の出力・画面の文言は、シークレットが混ざりうるためここには残していません。",
    "",
    `<!-- ${MANUAL_STEP_TROUBLE_MARKER}:${record.stepOrder ?? ""}:${record.category ?? ""} -->`,
  );
  return lines.join("\n");
}

/** 目印の行（`<!-- manual-step-trouble:3:display -->`） */
const MARKER_PATTERN = new RegExp(
  `<!--\\s*${MANUAL_STEP_TROUBLE_MARKER}:(\\d*):([a-z_]*)\\s*-->`,
);

/** 箇条書きから値を1つ引く */
function pickBullet(body: string, label: string): string {
  const found = new RegExp(`^-[^\\S\\n]*${label}:[^\\S\\n]*(\\S.*)$`, "m").exec(body);
  return found === null ? "" : found[1].trim();
}

/**
 * コメント一覧から、記録されたつまずきを読み直す（#2299）。
 *
 * 次に同じ手作業を開いた人の最初の画面へ出すためのもの。**読めなかったコメントは黙って外す**
 * ——古い書き方のコメントで画面を壊さない（記録は増えるだけで、消える経路が無い）。
 */
export function parseManualStepTroubleComments(
  comments: { body: string }[],
): ManualStepTroubleRecord[] {
  const records: ManualStepTroubleRecord[] = [];
  for (const comment of comments) {
    const marker = MARKER_PATTERN.exec(comment.body);
    if (marker === null) continue;

    const stepOrder = marker[1] === "" ? null : Number.parseInt(marker[1], 10);
    const category = MANUAL_STEP_TROUBLE_CATEGORIES.some((entry) => entry.value === marker[2])
      ? (marker[2] as ManualStepTroubleCategory)
      : null;
    const detail = pickBullet(comment.body, "起きたこと");
    if (detail === "") continue;

    records.push({
      stepOrder: stepOrder !== null && Number.isFinite(stepOrder) ? stepOrder : null,
      stepCount: null,
      stepText: pickBullet(comment.body, "つまずいたところ"),
      category,
      detail,
    });
  }
  return records;
}
