import { isPlanComment } from "@/lib/github/planning-phase";
import type { IssueComment } from "@/types/issue";

const PLAN_REVIEW_MARKER = "<!-- supervisor:plan-review -->";
const PLAN_REVISER_MARKER = "<!-- issue-deck-agent:plan-reviser -->";

/**
 * 最新の計画コメントより後に届いていて、まだ実装エージェントが応答していない計画レビューのコメント
 * （#3521・#3554）。無ければnull。
 *
 * コメントに時刻は無いので、並び順（時系列）で判定する。計画コメントの判定は`isPlanComment`を使う
 * （`plan-base`の行は付かない計画があるため、それをアンカーにしない）。**同じ計画に複数のレビューが
 * 付いていたら、いちばん新しいものを返す**（後ろから見て最初に当たったもの）。
 */
export function findPendingPlanReviewComment<T extends Pick<IssueComment, "body" | "author">>(
  comments: readonly T[],
): T | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.body.includes(PLAN_REVISER_MARKER)) return null;
    if (comment.body.includes(PLAN_REVIEW_MARKER)) return comment;
    if (isPlanComment(comment)) return null;
  }
  return null;
}

/** 最新の計画コメントより後に計画レビューが届いていて、まだ実装エージェントが応答していないか（#3521） */
export function isPlanReviewPending(
  comments: readonly Pick<IssueComment, "body" | "author">[],
): boolean {
  return findPendingPlanReviewComment(comments) !== null;
}

/**
 * 計画レビューの末尾1行の推奨（`.github/prompts/plan-review.md`「承認可否の推奨」）。
 * 3つの定型句に当たらなければ`other`（本文はそのまま`text`で出す）。
 */
export type PlanReviewRecommendationKind = "approve" | "revise" | "redo" | "other";

export type PlanReviewRecommendation = {
  kind: PlanReviewRecommendationKind;
  /** `推奨:`の後ろの全文（理由を含む） */
  text: string;
  /** 定型句の後ろに書かれた理由。定型句に当たらないとき・理由が無いときはnull */
  reason: string | null;
};

/**
 * 計画レビューの指摘1件。プロンプトは1件ごとに`**N. 見出し**`で始め、その下に
 * `- **指摘**`・`- **根拠**`・`- **提案**`の3項目を書かせている。**項目は見出しの下の
 * 箇条書きから拾い、欠けていればnull**（書式は自由記述の慣習頼みなので、欠けても落とさない）。
 */
export type PlanReviewFinding = {
  /** レビューが振った番号。修正依頼で「どの指摘か」を指すのに使う */
  number: number;
  title: string;
  problem: string | null;
  /** 入れ子の箇条書きを含むMarkdown。画面では畳んで出す */
  evidence: string | null;
  proposal: string | null;
  /** 3項目のどれにも入らなかった行。3項目が1つも読めなかったときの本文の代わりにもなる */
  rest: string | null;
};

export type ParsedPlanReview = {
  /** 最初の指摘より前の段落（前提の確認など）。無ければnull */
  summary: string | null;
  findings: PlanReviewFinding[];
  /** 「指摘なし」と書かれていて、指摘の見出しも無い */
  noFindings: boolean;
  recommendation: PlanReviewRecommendation | null;
  /**
   * マーカー・冒頭の見出し・実行ログの行を落とした本文。指摘に分けられなかったときに
   * そのまま出す（`findings`が空で`noFindings`でもない場合）。
   */
  body: string;
};

/** 本文から落とす行。マーカー（HTMLコメント）・冒頭の`## 計画レビュー（G1）`・無人実行の実行ログ */
const DROPPED_LINE_PATTERNS = [
  /^\s*<!--.*-->\s*$/,
  /^\s{0,3}#{1,6}\s*計画レビュー/,
  /^\s*実行ログ[:：]\s*\S*\s*$/,
];

/**
 * 指摘の見出し。**`**1. 見出し**`が実物の形**で、見出し記法（`### 1. 見出し`）でも書かれうる。
 * 番号の区切りは`.`・`．`・`)`・`）`を受ける。
 */
const FINDING_HEADING_PATTERN =
  /^\s{0,3}(?:\*\*\s*(\d+)\s*[.．)）]\s*(.+?)\s*\*\*\s*$|#{2,6}\s*(\d+)\s*[.．)）]\s*(.+?)\s*$)/;

/** 末尾1行の推奨。`**推奨**:`のように強調されていても拾う */
const RECOMMENDATION_PATTERN = /^\s*(?:\*\*)?推奨(?:\*\*)?\s*[:：]\s*(.+?)\s*$/;

/** 指摘の下の3項目。`- **指摘**: …`・`- **指摘** — …`の両方を受ける */
const FIELD_PATTERN = /^[-*]\s+\*\*(指摘|根拠|提案)\*\*\s*(?:[:：]|—|-)?\s*(.*)$/;

/** 「指摘なし」の宣言。行頭の`**指摘なし。**`・`指摘なし。`のどちらも実物にある */
const NO_FINDINGS_PATTERN = /^\s*(?:\*\*)?\s*指摘なし/m;

/** 定型句と種別の対応。**長い句から順に**当てる（「作り直し」は「計画の作り直し」の一部のため） */
const RECOMMENDATION_PHRASES: readonly [string, PlanReviewRecommendationKind][] = [
  ["このまま承認してよい", "approve"],
  ["このまま承認", "approve"],
  ["修正のうえ承認", "revise"],
  ["計画の作り直し", "redo"],
  ["作り直し", "redo"],
];

function parseRecommendation(text: string): PlanReviewRecommendation {
  const hit = RECOMMENDATION_PHRASES.find(([phrase]) => text.startsWith(phrase));
  if (!hit) return { kind: "other", text, reason: null };
  // 理由は「。」の後ろか、全角括弧の中に書かれる（実物は両方ある）
  const reason = text
    .slice(hit[0].length)
    .replace(/^[\s。、,:：]+/, "")
    .replace(/^（([\s\S]*)）$/, "$1")
    .trim();
  return { kind: hit[1], text, reason: reason === "" ? null : reason };
}

/** 空行を前後から詰め、全行に共通する先頭の空白を落とす（入れ子の箇条書きの字下げは保つ） */
function tidy(lines: readonly string[]): string | null {
  const text = lines.join("\n").replace(/^\s*\n/, "").trimEnd();
  if (text.trim() === "") return null;
  const indents = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^ */)![0].length);
  const common = Math.min(...indents);
  return text
    .split("\n")
    .map((line) => line.slice(Math.min(common, line.match(/^ */)![0].length)))
    .join("\n")
    .trim();
}

function parseFinding(number: number, title: string, lines: readonly string[]): PlanReviewFinding {
  const fields: Record<"指摘" | "根拠" | "提案", string[] | null> = {
    指摘: null,
    根拠: null,
    提案: null,
  };
  const rest: string[] = [];
  let current: string[] = rest;

  for (const line of lines) {
    const field = FIELD_PATTERN.exec(line);
    if (field) {
      const name = field[1] as keyof typeof fields;
      current = [];
      fields[name] = current;
      if (field[2].trim() !== "") current.push(field[2]);
      continue;
    }
    // 字下げの無い箇条書きは次の項目の始まりなので、直前の項目には入れない
    if (current !== rest && /^[-*]\s/.test(line)) current = rest;
    current.push(line);
  }

  return {
    number,
    title,
    problem: fields.指摘 ? tidy(fields.指摘) : null,
    evidence: fields.根拠 ? tidy(fields.根拠) : null,
    proposal: fields.提案 ? tidy(fields.提案) : null,
    rest: tidy(rest),
  };
}

/**
 * 計画レビューのコメント本文を、推奨・前置き・指摘に分ける（#3554）。
 *
 * **分けられなくても何も落とさない。** 指摘の見出しが1つも読めず「指摘なし」でもなければ、
 * `findings`を空にして`body`をそのまま出させる（画面は従来どおりの一括反映に戻る）。
 */
export function parsePlanReview(rawBody: string): ParsedPlanReview {
  const lines = rawBody
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !DROPPED_LINE_PATTERNS.some((pattern) => pattern.test(line)));

  // 推奨は末尾の1行なので、後ろから探して本文から抜く
  let recommendation: PlanReviewRecommendation | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = RECOMMENDATION_PATTERN.exec(lines[i]);
    if (match) {
      recommendation = parseRecommendation(match[1]);
      lines.splice(i, 1);
      break;
    }
  }

  const body = tidy(lines) ?? "";
  const summary: string[] = [];
  const findings: PlanReviewFinding[] = [];
  let current: { number: number; title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const heading = FINDING_HEADING_PATTERN.exec(line);
    if (heading) {
      if (current) findings.push(parseFinding(current.number, current.title, current.lines));
      current = {
        number: Number(heading[1] ?? heading[3]),
        title: (heading[2] ?? heading[4]).trim(),
        lines: [],
      };
      continue;
    }
    (current ? current.lines : summary).push(line);
  }
  if (current) findings.push(parseFinding(current.number, current.title, current.lines));

  return {
    summary: findings.length > 0 ? tidy(summary) : null,
    findings,
    noFindings: findings.length === 0 && NO_FINDINGS_PATTERN.test(body),
    recommendation,
    body,
  };
}

export type PendingPlanReview = {
  /** 元のコメント。カードの`key`に使い、レビューが差し替わったら選択を持ち越さない */
  commentId: string;
  review: ParsedPlanReview;
  createdAtLabel: string;
};

/**
 * 画面に出す未反映の計画レビュー（#3554）。コメントを選び、本文を分けて投稿日時の表示を添える。
 * 無ければnull。
 */
export function resolvePendingPlanReview(
  comments: readonly Pick<IssueComment, "id" | "body" | "author" | "createdAtLabel">[],
): PendingPlanReview | null {
  const comment = findPendingPlanReviewComment(comments);
  if (!comment) return null;
  return {
    commentId: comment.id,
    review: parsePlanReview(comment.body),
    createdAtLabel: comment.createdAtLabel,
  };
}
