/**
 * リリースPR（develop→main）の本文から「コードレビューの検証結果」を読み取る（#2448）。
 *
 * **書いているのは`.github/workflows/reusable-release-develop-to-main.yml`の
 * 「対象issueの検証結果を集計する」ステップ**で、各Issueに対応するdevelop向けPRの本文に
 * 残った`## 検証結果`の節（`reusable-claude-review-develop.yml`が書く）を集めたもの。
 * ここではその表をそのまま読む。
 *
 * **表の下には、レビューコメントの本文そのものが折りたたみで載っている**（#2488）。判定だけ
 * では何を指摘されたのかが読めず、mainへ出すかを決める場から各PRのコメントを1件ずつ開くことに
 * なっていた。本文もここで拾い、画面のパネルから開けるようにする。
 *
 * **JSONブロックは持たせない。** GitHubでそのまま読める表の中から読み取る方針は、
 * リポジトリ全体のコードレビュー（`code-review.ts`）と揃えてある。ずれると黙って
 * パネルが出なくなるため、見出しの文字列は`scripts/check-review-verdict-marker.sh`が
 * ワークフローと突き合わせる。
 */

/** リリースPR本文でこの見出しの下に表がある。ワークフロー側と対（CIで突き合わせる） */
const TABLE_HEADING = "## コードレビューの検証結果";

/** Markdownの見出し行。表の範囲は次の見出しの手前で打ち切る */
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s/;

/** `| --- | --- |`の区切り行 */
const SEPARATOR_PATTERN = /^\|[\s:|-]+\|$/;

/**
 * 表の下に続くレビューコメント本文の折りたたみ（#2488）。ワークフロー側と対（CIで突き合わせる）。
 *
 * 書式は`<!-- issue-deck-review-detail:start issue=<番号> -->`から
 * `<!-- issue-deck-review-detail:end -->`まで。開始マーカーで表の読み取りも打ち切る
 * ——**レビュー本文の中に表が入っていることがある**ため、打ち切らないとそれを検証結果の
 * 行として読み込みかねない。
 */
const DETAIL_START_PATTERN = /<!--\s*issue-deck-review-detail:start\s+issue=(\d+)[^>]*-->/;
const DETAIL_END_MARKER = "<!-- issue-deck-review-detail:end -->";

/**
 * 自動レビューの判定。**5つだけ**で、これ以上増やさない（色と判断が1対1で対応しなくなる）。
 *
 * - `ok` … 問題なし（LGTM）
 * - `needs-check` … 要確認、または自動マージ不可カテゴリに該当
 * - `changes-requested` … 要修正
 * - `skipped` … 低リスクかつ小規模なため自動レビューを省いた（#992のゲート）。**危険信号ではない**
 * - `unknown` … 記録が無い／判定を取得できなかった
 */
export type ReviewVerdictKind = "ok" | "needs-check" | "changes-requested" | "skipped" | "unknown";

/** 機械的リスク判定（`risk-check`ジョブ）の結果 */
export type RiskVerdictKind = "none" | "hit" | "unknown";

export type ReleaseVerificationRow = {
  issueNumber: number;
  /**
   * 同じ本文の`## 対象issue`から拾ったタイトル。番号だけでは何が入ったのか読めないため添える。
   * 一覧に載っていない場合はnull（表の行と対象issue一覧は別々に作られるため揃わないことがある）。
   */
  issueTitle: string | null;
  /** 対応するdevelop向けPR。見つからなかった場合はnull */
  pullRequestNumber: number | null;
  reviewKind: ReviewVerdictKind;
  /** 表のセルから記号を落とした文言（「問題なし」「実施なし（低リスク・小規模）」など） */
  reviewLabel: string;
  riskKind: RiskVerdictKind;
  riskLabel: string;
  /**
   * 自動レビューがdevelop向けPRへ投稿したコメントの本文（#2488）。長い場合はワークフローが
   * 打ち切り、末尾に元コメントへのリンクを添えている。記録が無ければnull
   * （ローカルのレビュー・統合エージェントがマージしたPRにはレビューコメントが無い）。
   */
  reviewBody: string | null;
};

export type ReleaseVerificationTally = {
  total: number;
  ok: number;
  needsCheck: number;
  changesRequested: number;
  skipped: number;
  unknown: number;
};

export type ReleaseVerification = {
  rows: ReleaseVerificationRow[];
  tally: ReleaseVerificationTally;
};

/** セルの先頭に付く記号と判定の対応。ワークフローが書く文言と対 */
const REVIEW_MARKS: readonly { mark: string; kind: ReviewVerdictKind }[] = [
  { mark: "✅", kind: "ok" },
  { mark: "⚠️", kind: "needs-check" },
  { mark: "❌", kind: "changes-requested" },
  { mark: "—", kind: "skipped" },
];

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return [];
  }
  // 先頭と末尾の`|`を落としてから分割する。セル内に`|`は入らない書式のため素朴に割ってよい。
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function parseNumber(cell: string): number | null {
  const matched = /^#(\d+)$/.exec(cell);
  return matched ? Number(matched[1]) : null;
}

function parseReview(cell: string): { kind: ReviewVerdictKind; label: string } {
  for (const { mark, kind } of REVIEW_MARKS) {
    if (cell.startsWith(mark)) {
      return { kind, label: cell.slice(mark.length).trim() || cell };
    }
  }
  // `? 記録なし`・`? 判定を取得できず`、および想定外の文言。**行ごと落とさない**——
  // 検証されていないことも読めなくなるため、unknownとして残す。
  return { kind: "unknown", label: cell.replace(/^\?\s*/, "").trim() || cell };
}

function parseRisk(cell: string): { kind: RiskVerdictKind; label: string } {
  if (cell.startsWith("⚠️")) {
    return { kind: "hit", label: cell.slice("⚠️".length).trim() || cell };
  }
  if (cell === "該当なし") {
    return { kind: "none", label: cell };
  }
  return { kind: "unknown", label: cell.replace(/^\?\s*/, "").trim() || cell };
}

/**
 * 同じ本文の`## 対象issue`から`- #<番号> <タイトル>`を拾う。取得できなかったときの注記
 * （`（issue-deckへ問い合わせできず…）`）はこの形にならないため混ざらない。
 */
function parseIssueTitles(lines: readonly string[]): Map<number, string> {
  const titles = new Map<number, string>();
  const start = lines.findIndex((line) => line.trim() === "## 対象issue");
  if (start < 0) {
    return titles;
  }
  for (const line of lines.slice(start + 1)) {
    if (HEADING_PATTERN.test(line)) {
      break;
    }
    const matched = /^\s*-\s+#(\d+)\s+(.*)$/.exec(line);
    if (matched) {
      titles.set(Number(matched[1]), matched[2].trim());
    }
  }
  return titles;
}

/**
 * 折りたたみに入っているレビューコメント本文をIssue番号ごとに拾う（#2488）。
 *
 * **表の行とは独立に拾う。** 本文が長くて打ち切られた回・レビューが走らなかったPRでは
 * 折りたたみそのものが無く、その場合は行に本文が付かないだけで表は従来どおり出る。
 */
function parseReviewBodies(lines: readonly string[]): Map<number, string> {
  const bodies = new Map<number, string>();
  let issueNumber: number | null = null;
  let collected: string[] = [];

  for (const line of lines) {
    if (issueNumber === null) {
      const matched = DETAIL_START_PATTERN.exec(line);
      if (matched) {
        issueNumber = Number(matched[1]);
        collected = [];
      }
      continue;
    }
    if (line.includes(DETAIL_END_MARKER)) {
      const body = collected.join("\n").trim();
      if (body !== "") {
        bodies.set(issueNumber, body);
      }
      issueNumber = null;
      continue;
    }
    collected.push(line);
  }
  return bodies;
}

function tally(rows: readonly ReleaseVerificationRow[]): ReleaseVerificationTally {
  return {
    total: rows.length,
    ok: rows.filter((row) => row.reviewKind === "ok").length,
    needsCheck: rows.filter((row) => row.reviewKind === "needs-check").length,
    changesRequested: rows.filter((row) => row.reviewKind === "changes-requested").length,
    skipped: rows.filter((row) => row.reviewKind === "skipped").length,
    unknown: rows.filter((row) => row.reviewKind === "unknown").length,
  };
}

/**
 * PR本文から検証結果の表を取り出す。見出しが無い・行が1件も無い場合はnull
 * （リリースPR以外のPRではそもそも見出しが無い）。
 */
export function parseReleaseVerification(body: string | null | undefined): ReleaseVerification | null {
  if (!body) {
    return null;
  }

  const lines = body.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((line) => line.trim() === TABLE_HEADING);
  if (start < 0) {
    return null;
  }

  const titles = parseIssueTitles(lines);
  const bodies = parseReviewBodies(lines);
  const rows: ReleaseVerificationRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING_PATTERN.test(line) || DETAIL_START_PATTERN.test(line)) {
      break;
    }
    if (SEPARATOR_PATTERN.test(line.trim())) {
      continue;
    }
    const cells = splitRow(line);
    if (cells.length < 4) {
      continue;
    }
    const issueNumber = parseNumber(cells[0]);
    if (issueNumber === null) {
      // ヘッダー行（`| Issue | PR | … |`）はここで落ちる
      continue;
    }
    const review = parseReview(cells[2]);
    const risk = parseRisk(cells[3]);
    rows.push({
      issueNumber,
      issueTitle: titles.get(issueNumber) ?? null,
      pullRequestNumber: parseNumber(cells[1]),
      reviewKind: review.kind,
      reviewLabel: review.label,
      riskKind: risk.kind,
      riskLabel: risk.label,
      reviewBody: bodies.get(issueNumber) ?? null,
    });
  }

  if (rows.length === 0) {
    return null;
  }
  return { rows, tally: tally(rows) };
}
