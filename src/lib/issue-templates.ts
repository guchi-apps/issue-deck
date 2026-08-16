/**
 * Issue作成の1段目で選べる本文テンプレート（#1745）。
 *
 * **テンプレートは「本文へ入れる見出しだけの骨組み」で、入力欄を項目ごとに分ける形
 * （GitHubのIssueフォーム風）は採らない。** 分けると、画像の貼り付け・`#123`のIssue補完
 * （`MentionTextarea`）・下書きの自動保存（`hooks/use-issue-draft.ts`）・別ウィンドウへの
 * 引き継ぎ（`lib/issue-create-window.ts`）・`POST /api/issues/quick-suggest`への本文渡しを
 * 項目ぶん作り直すことになり、得られるのは記入欄の見た目の差だけになる。
 *
 * **見出しに説明文を添えない。** 消し忘れがそのままIssue本文に残るため、何を書くかは
 * 画面側（選択中のチップの下の1行＝`hint`）で示す。
 */
export type IssueTemplateId = "feature" | "improve" | "bug";

export type IssueTemplate = {
  id: IssueTemplateId;
  /** チップに出す名前。**スマホ（本文幅 約329px）で3つが1行に収まる長さに抑える** */
  label: string;
  /** 選択中に1行で出す説明。何を書く形になるかを示す */
  hint: string;
  /** 本文へ入れる骨組み */
  body: string;
};

/**
 * テンプレートは3種（#1745）。このリポジトリの種別ラベルと実際のIssueの書き方
 * （#1713・#1689＝不具合、#1690・#1676・#1750＝改善／見た目、#1744＝機能追加）から決めた。
 *
 * **「あるものを変えたい」（`51.improvement`・`62.design`）を1つにまとめている。** 実際に
 * 一番多いのがこの形で、見た目の整理も「いまどうなっているか → どう変えたいか」という
 * 同じ書き方だった。分けているのは「無いものを作る」（`50.feature`）と「意図どおりに
 * 動かない」（`30.bug`・`40.unexpected`）で、最初に書く対象が変わるもの同士。
 */
export const ISSUE_TEMPLATES: IssueTemplate[] = [
  {
    id: "feature",
    label: "機能追加",
    hint: "追加したい機能と、なぜ必要かを書く形にします。理由があると、そのままでは難しいときに代替案を出せます。",
    body: ["## 追加したい機能", "", "## なぜ追加したいか（解決したいこと）", "", "## 補足（あれば）", ""].join(
      "\n",
    ),
  },
  {
    id: "improve",
    label: "改善・見た目",
    hint: "いまどうなっているかと、どう変えたいかを書く形にします。対象の画面が分かると、直す先が決まります。",
    body: [
      "## 対象の画面・機能",
      "",
      "## いまどうなっているか",
      "",
      "## どう変えたいか",
      "",
      "## なぜ変えたいか",
      "",
    ].join("\n"),
  },
  {
    id: "bug",
    label: "不具合",
    hint: "何が起きていて、どう操作すると起きるかを書く形にします。再現できないと直したかどうかも確かめられません。",
    body: ["## 起きていること", "", "## どんな操作・条件で起きるか", "", "## どうなってほしいか", ""].join(
      "\n",
    ),
  },
];

export function findIssueTemplate(id: IssueTemplateId | null): IssueTemplate | null {
  if (!id) return null;
  return ISSUE_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * 本文が「入れたままの骨組み」または空か（＝消しても何も失われない状態か）。
 *
 * 空行の増減で判定が崩れないよう、両側を`trim()`して比較する。
 */
function isBodyUntouched(body: string, appliedId: IssueTemplateId | null): boolean {
  if (!body.trim()) return true;
  const applied = findIssueTemplate(appliedId);
  return applied !== null && body.trim() === applied.body.trim();
}

/**
 * テンプレートを選んだまま、項目を1つも埋めていないか（#1745）。
 *
 * **この状態では「次へ」を押せないようにする。** 見出しだけを材料にリポジトリ・タイトル・
 * ラベルを推定させると、確認ステップに内容と関係の無い値が並ぶ。
 */
export function isUnfilledTemplateBody(body: string, appliedId: IssueTemplateId | null): boolean {
  const applied = findIssueTemplate(appliedId);
  return applied !== null && body.trim() === applied.body.trim();
}

export type IssueTemplateChange =
  /** そのまま本文を入れ替える（`templateId`が`null`なら選択を外して空にする） */
  | { kind: "apply"; templateId: IssueTemplateId | null; body: string }
  /** 書いた内容があるため、置き換えてよいか確認する */
  | { kind: "confirm" }
  /** 選択だけ外し、本文は消さない */
  | { kind: "detach" };

/**
 * テンプレートのチップを押したときに何をするかを決める（#1745）。
 *
 * **自分で書いた内容を黙って消さない。** 骨組みのままなら確認せず入れ替え、
 * 書いた内容があるときだけ確認する（`confirm`）。
 *
 * 選択中のチップを押し直したときは選択を外す。**「使わない」チップは置かない**——
 * チップが4つになるとスマホで1行に収まらず、選択を外すのは押し直しで足りる。
 */
export function resolveTemplateChange({
  nextId,
  appliedId,
  body,
}: {
  nextId: IssueTemplateId;
  appliedId: IssueTemplateId | null;
  body: string;
}): IssueTemplateChange {
  const untouched = isBodyUntouched(body, appliedId);
  if (nextId === appliedId) {
    // 押し直しで選択を外す。骨組みのままなら本文も空へ戻す（入力欄のプレースホルダーが戻る）
    return untouched ? { kind: "apply", templateId: null, body: "" } : { kind: "detach" };
  }
  if (!untouched) return { kind: "confirm" };
  const next = findIssueTemplate(nextId);
  if (!next) return { kind: "detach" };
  return { kind: "apply", templateId: next.id, body: next.body };
}
