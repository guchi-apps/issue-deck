import { isPlanComment } from "@/lib/github/planning-phase";
import type { IssueComment } from "@/types/issue";

export const PLAN_REVIEW_MARKER = "<!-- supervisor:plan-review -->";
const PLAN_REVISER_MARKER = "<!-- issue-deck-agent:plan-reviser -->";

/**
 * 最新の計画コメントより後に届いていて、まだ実装エージェントが応答していない計画レビューのコメント
 * （#3521・#3554）。無ければnull。
 *
 * コメントに時刻は無いので、並び順（時系列）で判定する。計画コメントの判定は`isPlanComment`を使う
 * （`plan-base`の行は付かない計画があるため、それをアンカーにしない）。**同じ計画に複数のレビューが
 * 付いていたら、いちばん新しいものを返す**（後ろから見て最初に当たったもの）。
 */
export function findPendingPlanReviewComment<
  T extends Pick<IssueComment, "body" | "author" | "authorTrusted">,
>(comments: readonly T[]): T | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    // マーカーは誰でも書けるので、信頼できる投稿者のコメントだけを見る（#3716）。外部の人が
    // `plan-reviser`を書いて本物の指摘を隠したり、`plan-review`を書いて偽の指摘を出したりできないように
    if (comment.authorTrusted !== true) continue;
    if (comment.body.includes(PLAN_REVISER_MARKER)) return null;
    if (comment.body.includes(PLAN_REVIEW_MARKER)) return comment;
    if (isPlanComment(comment)) return null;
  }
  return null;
}

/** 最新の計画コメントより後に計画レビューが届いていて、まだ実装エージェントが応答していないか（#3521） */
export function isPlanReviewPending(
  comments: readonly Pick<IssueComment, "body" | "author" | "authorTrusted">[],
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
  /**
   * 区分（#3765）。`blocking`＝計画を直さなければ実装の成立・安全性・受け入れ条件を損なう重大な指摘、
   * `note`＝実装時に対応できる補足。**区分の行が無い旧形式は`null`で、重大として扱う**（安全側）
   */
  severity: "blocking" | "note" | null;
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

/** 判断の選択肢1つ。`letter`は`A`〜、`label`は1行の題、`description`は題の後ろの補足 */
export type PlanReviewDecisionOption = {
  letter: string;
  label: string;
  description: string | null;
  /** レビューが推奨している選択肢か */
  recommended: boolean;
};

/**
 * 計画レビューが「人が決めるべき論点」として書いた判断1件（#3660）。プロンプトは`**判断N. 見出し**`で
 * 始め、`- **論点**`・`- **選択肢**`（入れ子の`A. …`）・`- **推奨**`を書かせる。
 * **選択肢が2つ未満なら選べないので判断として扱わず、指摘の本文へ残す**（`parsePlanReview`）。
 */
export type PlanReviewDecision = {
  number: number;
  title: string;
  question: string | null;
  options: PlanReviewDecisionOption[];
};

export type ParsedPlanReview = {
  /** 最初の指摘より前の段落（前提の確認など）。無ければnull */
  summary: string | null;
  findings: PlanReviewFinding[];
  /** 人が選ぶ判断（#3660）。判断の書式が無い旧レビューでは空 */
  decisions: PlanReviewDecision[];
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

/** 判断の見出し。`**判断1. 見出し**`か`### 判断1. 見出し`（指摘の見出しと番号が別なので`判断`の語で見分ける） */
const DECISION_HEADING_PATTERN =
  /^\s{0,3}(?:\*\*\s*判断\s*(\d+)\s*[.．)）:：]\s*(.+?)\s*\*\*\s*$|#{2,6}\s*判断\s*(\d+)\s*[.．)）:：]\s*(.+?)\s*$)/;

/** 判断の下の3項目 */
const DECISION_FIELD_PATTERN = /^[-*]\s+\*\*(論点|選択肢|推奨)\*\*\s*(?:[:：]|—|-)?\s*(.*)$/;

/** 選択肢の行。`- A. 題 — 補足`・`A) 題`のどちらも受ける */
const DECISION_OPTION_PATTERN = /^\s*(?:[-*]\s+)?([A-Z])\s*[.．)）]\s*(.+?)\s*$/;

/** 末尾1行の推奨。`**推奨**:`のように強調されていても拾う */
const RECOMMENDATION_PATTERN = /^\s*(?:\*\*)?推奨(?:\*\*)?\s*[:：]\s*(.+?)\s*$/;

/** 指摘の下の3項目。`- **指摘**: …`・`- **指摘** — …`の両方を受ける */
const FIELD_PATTERN = /^[-*]\s+\*\*(区分|指摘|根拠|提案)\*\*\s*(?:[:：]|—|-)?\s*(.*)$/;

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
  const fields: Record<"区分" | "指摘" | "根拠" | "提案", string[] | null> = {
    区分: null,
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

  const severityText = fields.区分 ? (tidy(fields.区分) ?? "") : "";
  const severity: PlanReviewFinding["severity"] = /補足|実装時/.test(severityText)
    ? "note"
    : /重大|計画修正|計画を直/.test(severityText)
      ? "blocking"
      : null;

  return {
    severity,
    number,
    title,
    problem: fields.指摘 ? tidy(fields.指摘) : null,
    evidence: fields.根拠 ? tidy(fields.根拠) : null,
    proposal: fields.提案 ? tidy(fields.提案) : null,
    rest: tidy(rest),
  };
}

function parseDecision(
  number: number,
  title: string,
  lines: readonly string[],
): PlanReviewDecision | null {
  const question: string[] = [];
  const optionLines: string[] = [];
  let recommendedLetter: string | null = null;
  let current: string[] | null = null;
  for (const line of lines) {
    const field = DECISION_FIELD_PATTERN.exec(line);
    if (field) {
      if (field[1] === "論点") current = question;
      else if (field[1] === "選択肢") current = optionLines;
      else {
        current = null;
        recommendedLetter = /^\s*([A-Z])(?![A-Za-z])/.exec(field[2])?.[1] ?? null;
      }
      if (current && field[2].trim() !== "") current.push(field[2]);
      continue;
    }
    if (current) current.push(line);
  }

  const options: PlanReviewDecisionOption[] = [];
  for (const line of optionLines) {
    const match = DECISION_OPTION_PATTERN.exec(line);
    if (!match) continue;
    const marked = /[（(]\s*推奨\s*[）)]/.test(match[2]);
    const text = match[2].replace(/[（(]\s*推奨\s*[）)]/, "").trim();
    const [label, ...rest] = text.split(/\s+[—―]\s+|\s*[:：]\s+/);
    options.push({
      letter: match[1],
      label: label.trim(),
      description: rest.join(" — ").trim() || null,
      recommended: marked,
    });
  }
  if (options.length < 2) return null;
  if (recommendedLetter) {
    for (const option of options) option.recommended = option.recommended || option.letter === recommendedLetter;
  }
  return { number, title, question: tidy(question), options };
}

/**
 * 計画レビューのコメント本文を、推奨・前置き・指摘・判断に分ける（#3554）。
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
  const decisions: PlanReviewDecision[] = [];
  type Block = { kind: "finding" | "decision"; number: number; title: string; lines: string[] };
  let current: Block | null = null;

  const flush = () => {
    if (!current) return;
    if (current.kind === "finding") {
      findings.push(parseFinding(current.number, current.title, current.lines));
    } else {
      const decision = parseDecision(current.number, current.title, current.lines);
      // 選択肢が読めない判断は選べないので、指摘として本文を残す（何も落とさない）
      if (decision) decisions.push(decision);
      else findings.push(parseFinding(current.number, current.title, current.lines));
    }
    current = null;
  };

  for (const line of lines) {
    const decisionHeading = DECISION_HEADING_PATTERN.exec(line);
    const heading = decisionHeading ? null : FINDING_HEADING_PATTERN.exec(line);
    if (decisionHeading || heading) {
      flush();
      current = decisionHeading
        ? {
            kind: "decision",
            number: Number(decisionHeading[1] ?? decisionHeading[3]),
            title: (decisionHeading[2] ?? decisionHeading[4]).trim(),
            lines: [],
          }
        : {
            kind: "finding",
            number: Number(heading![1] ?? heading![3]),
            title: (heading![2] ?? heading![4]).trim(),
            lines: [],
          };
      continue;
    }
    (current ? current.lines : summary).push(line);
  }
  flush();

  const hasItems = findings.length > 0 || decisions.length > 0;
  return {
    summary: hasItems ? tidy(summary) : null,
    findings,
    decisions,
    noFindings: !hasItems && NO_FINDINGS_PATTERN.test(body),
    recommendation,
    body,
  };
}

export type PlanReviewNotice = {
  kind: "skipped" | "limit" | "unresolved";
  /** 理由（コメント本文の最初の行から装飾を落としたもの） */
  text: string;
};

const NOTICE_MARKERS: readonly [string, PlanReviewNotice["kind"]][] = [
  ["<!-- issue-deck:plan-review-skipped -->", "skipped"],
  ["<!-- issue-deck:plan-review-limit -->", "limit"],
  ["<!-- issue-deck:plan-review-unresolved -->", "unresolved"],
];

/**
 * 最新の計画コメントより後にある、計画レビューの省略・打ち止め・未解消の記録（#3765）。
 * 画面は「レビュー省略」などの短い理由を出し、存在しないレビューを待たせない。無ければnull。
 */
export function resolvePlanReviewNotice(
  comments: readonly Pick<IssueComment, "body" | "author" | "authorTrusted">[],
): PlanReviewNotice | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.authorTrusted !== true) continue;
    if (isPlanComment(comment)) return null;
    const hit = NOTICE_MARKERS.find(([marker]) => comment.body.includes(marker));
    if (hit) {
      const first = comment.body.split("\n").find((line) => line.trim() !== "") ?? "";
      return { kind: hit[1], text: first.replace(/\*\*/g, "").trim() };
    }
  }
  return null;
}

export type PendingPlanReview = {
  /** 元のコメント。カードの`key`に使い、レビューが差し替わったら選択を持ち越さない */
  commentId: string;
  review: ParsedPlanReview;
  createdAtLabel: string;
  /**
   * このIssueで何回目の計画レビューか（1始まり。#3757）。信頼できる投稿者の計画レビューコメントを、
   * 表示するものまで数える。計画の版ではなくレビューの回数で、同じ計画への再レビューも1回に数える
   */
  round: number;
  /** 初回レビューか解消確認か（#3765） */
  kind: "initial" | "resolve";
};

/**
 * 画面に出す未反映の計画レビュー（#3554）。コメントを選び、本文を分けて投稿日時の表示を添える。
 * 無ければnull。
 */
export function resolvePendingPlanReview(
  comments: readonly Pick<IssueComment, "id" | "body" | "author" | "authorTrusted" | "createdAtLabel">[],
): PendingPlanReview | null {
  const comment = findPendingPlanReviewComment(comments);
  if (!comment) return null;
  const index = comments.indexOf(comment);
  const round = comments
    .slice(0, index + 1)
    .filter((item) => item.authorTrusted === true && item.body.includes(PLAN_REVIEW_MARKER)).length;
  return {
    commentId: comment.id,
    review: parsePlanReview(comment.body),
    createdAtLabel: comment.createdAtLabel,
    round,
    kind: readPlanReviewKind(comment.body),
  };
}

/**
 * 自動反映の対象になる「計画を直さなければならない重大な指摘」があるか（#3765）。
 * 補足（`note`）だけ・指摘なしなら`false`で、計画の出し直しも再レビューも要求しない。
 * 区分が読めない旧形式の指摘は重大として数える。
 */
export function hasBlockingFindings(review: ParsedPlanReview): boolean {
  // 書式が崩れて指摘に分けられなかった本文は、補足だけと言い切れないので重大として扱う
  if (review.findings.length === 0) return review.decisions.length === 0 && !review.noFindings;
  return review.findings.some((finding) => finding.severity !== "note");
}

/**
 * 指摘が実装時対応の補足（`note`）だけで、人が選ぶ判断が無く、推奨も「このまま承認」か（#3850）。
 * 該当するレビューは、各指摘の反映・見送りを選ばせず承認だけに進ませる。
 */
export function isNoteOnlyApprove(review: ParsedPlanReview | null): boolean {
  if (review === null) return false;
  return (
    review.findings.length > 0 &&
    review.decisions.length === 0 &&
    review.findings.every((finding) => finding.severity === "note") &&
    review.recommendation?.kind === "approve"
  );
}

/** 計画レビューの種別（`## 計画レビュー（G1・解消確認）`の見出しで見分ける。見出しが無ければ初回） */
export function readPlanReviewKind(body: string): "initial" | "resolve" {
  return /^\s{0,3}#{1,6}\s*計画レビュー[（(]\s*G1\s*[・･]\s*解消確認/m.test(body) ? "resolve" : "initial";
}
