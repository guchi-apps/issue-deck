import type { ReviewVerdictKind, RiskVerdictKind } from "@/lib/github/release-verification";

/**
 * PR本文に残っている`## 検証結果`の節から、そのPR1本ぶんの自動レビュー判定を読み取る（#2843）。
 *
 * **書いているのは`.github/workflows/reusable-claude-review-develop.yml`の
 * 「検証結果をPR本文へ記録する」ステップ**（とローカルのレビュー・統合エージェント。
 * `scripts/prompts/review-agent.md`）で、develop向けPRの本文の末尾へ
 * `<!-- issue-deck-verification:start review=<判定> risk=<none|hit> -->`から
 * `<!-- issue-deck-verification:end -->`までを置いている。
 *
 * リリースPR（develop→main）はこの節を対象issueぶん集めて表にしており、そちらを読むのが
 * [`release-verification.ts`](./release-verification.ts)。**同じ判定を、集められる前の
 * 1本ぶんとして読むのがこちら**で、判定の語彙（`ReviewVerdictKind`・`RiskVerdictKind`）は
 * 揃えてある。ずれると片方だけが黙って「記録なし」へ倒れるため、マーカーの文字列は
 * `scripts/check-review-verdict-marker.sh`がワークフローと突き合わせる。
 *
 * **問い合わせはしない。** 材料はPR本文だけで、PR一覧・PR詳細のどちらの経路も本文を既に
 * 受け取っている（`GithubApiOpenPullRequest.body`）。マージ確認ダイアログでこれを出しても
 * GitHub APIの消費は増えない。
 */

/** 節の開始マーカー。ワークフロー側と対（CIで突き合わせる） */
const SECTION_START_PATTERN =
  /<!--\s*issue-deck-verification:start\s+review=([A-Za-z-]+)\s+risk=([A-Za-z-]+)\s*-->/;

/**
 * 判定したときのheadコミット（#3172）。**節の中の1行**で、開始マーカーの属性ではない。
 *
 * 属性にすると、`review=`・`risk=`の直後が`-->`である前提で読んでいる版（この変更より前の
 * 画面。本番へ出るのはリリース後）が節ごと「記録なし」に倒れ、要修正のPRでマージ警告が
 * 消える時間帯ができる。別行なら古い読み手は黙って読み飛ばす。
 *
 * **無くても判定は読める。** この変更より前に書かれたPRの本文と、共有ワークフローの新しい
 * タグがまだ配られていないリポジトリのPRには入っていない。読めないときは「判定時点の
 * コミットが分からない」であって「古い」ではないため、`reviewedSha`をnullにして鮮度を
 * 出さない側へ倒す（`resolveReviewVerdictFreshness`）。
 */
const SECTION_SHA_PATTERN = /<!--\s*issue-deck-verification:sha=([0-9a-fA-F]+)\s*-->/;

const SECTION_END_MARKER = "<!-- issue-deck-verification:end -->";

/** 箇条書きの先頭に付く記号。落として文言だけを残す */
const LABEL_MARKS = ["✅", "⚠️", "❌", "—", "?"] as const;

/**
 * `review=`の値と画面の判定の対応。**ワークフローが書く値がすべてここに載っていること。**
 * 載っていない値（将来増えたもの）は`unknown`＝「記録なし」に倒し、行ごと落とさない。
 */
const REVIEW_KINDS: Readonly<Record<string, ReviewVerdictKind>> = {
  lgtm: "ok",
  "needs-check": "needs-check",
  "changes-requested": "changes-requested",
  skipped: "skipped",
};

const RISK_KINDS: Readonly<Record<string, RiskVerdictKind>> = {
  none: "none",
  hit: "hit",
};

export type PullRequestReviewVerdict = {
  reviewKind: ReviewVerdictKind;
  /** 「問題なし（LGTM）」「要修正」など、節に書かれていた文言。読めなければ既定の文言 */
  reviewLabel: string;
  riskKind: RiskVerdictKind;
  riskLabel: string;
  /** リスクに該当した理由（`risk=hit`のときだけ節にぶら下がる）。無ければ空 */
  riskReasons: string[];
  /** 「ユーザーの確認」の行の文言。書かれていなければnull */
  confirmLabel: string | null;
  /**
   * 判定したときのheadコミット（#3172）。節に`sha=`の行が無ければnull。
   *
   * **PRの最新コミットと突き合わせて「いまの中身に対する判定か」を出すためだけに使う。**
   * 判定そのもの（`reviewKind`）はこれが無くても読めるので、欠けていても行ごと落とさない。
   */
  reviewedSha: string | null;
};

/** 判定が読めなかったときに出す文言。`unknown`は「判定できなかった」であって危険信号ではない */
const FALLBACK_REVIEW_LABEL = "記録なし";
const FALLBACK_RISK_LABEL = "記録なし";

function stripMark(text: string): string {
  for (const mark of LABEL_MARKS) {
    if (text.startsWith(mark)) {
      return text.slice(mark.length).trim() || text;
    }
  }
  return text;
}

/** `- <見出し>: <値>` の行から値を取り出す。無ければnull */
function findBullet(lines: readonly string[], heading: string): string | null {
  const pattern = new RegExp(`^\\s*-\\s*${heading}\\s*[:：]\\s*(.+)$`);
  for (const line of lines) {
    const matched = pattern.exec(line);
    if (matched) {
      return matched[1].trim();
    }
  }
  return null;
}

/**
 * `- 機械的リスク判定:`の下にぶら下がる`  - <理由>`を拾う。ワークフローは`risk=hit`の
 * ときだけ書くため、該当なしのPRでは空になる。
 */
function findRiskReasons(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => /^\s*-\s*機械的リスク判定\s*[:：]/.test(line));
  if (start < 0) return [];

  const reasons: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const matched = /^\s{2,}-\s+(.+)$/.exec(line);
    if (!matched) break;
    reasons.push(matched[1].trim());
  }
  return reasons;
}

/** 節の中の`<!-- issue-deck-verification:sha=… -->`からコミットを取り出す。無ければnull */
function findReviewedSha(lines: readonly string[]): string | null {
  for (const line of lines) {
    const matched = SECTION_SHA_PATTERN.exec(line);
    if (matched) return matched[1];
  }
  return null;
}

/**
 * PR本文から検証結果の節を読み取る。節が無ければnull（自動レビューを持たないリポジトリのPR・
 * レビューがまだ走っていないPR）。
 *
 * **判定そのものは開始マーカーの`review=`・`risk=`から取る**——箇条書きの文言は表示のための
 * ものなので、語が増えたときに読み取りが壊れないようにする。文言はラベルとして添えるだけ。
 */
export function parsePullRequestReviewVerdict(
  body: string | null | undefined,
): PullRequestReviewVerdict | null {
  if (!body) return null;

  const lines = body.replace(/\r/g, "").split("\n");
  const startIndex = lines.findIndex((line) => SECTION_START_PATTERN.test(line));
  if (startIndex < 0) return null;

  const matched = SECTION_START_PATTERN.exec(lines[startIndex]);
  if (!matched) return null;

  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.includes(SECTION_END_MARKER),
  );
  const section = lines.slice(startIndex + 1, endIndex < 0 ? undefined : endIndex);

  const reviewLabel = findBullet(section, "自動レビュー");
  const riskLabel = findBullet(section, "機械的リスク判定");
  const confirmLabel = findBullet(section, "ユーザーの確認");

  return {
    reviewKind: REVIEW_KINDS[matched[1]] ?? "unknown",
    reviewLabel: reviewLabel ? stripMark(reviewLabel) : FALLBACK_REVIEW_LABEL,
    riskKind: RISK_KINDS[matched[2]] ?? "unknown",
    riskLabel: riskLabel ? stripMark(riskLabel) : FALLBACK_RISK_LABEL,
    riskReasons: findRiskReasons(section),
    confirmLabel: confirmLabel ?? null,
    reviewedSha: findReviewedSha(section),
  };
}

/**
 * マージの前に人が読むべき判定か（#2843）。
 *
 * **`skipped`と`unknown`は含めない。** 低リスクかつ小規模なPRでレビューを省くのは設計どおりの
 * 動きで（#992のゲート）、判定を取得できなかったのも危険信号ではない。ここをtrueにすると
 * ほぼ全てのPRで確認ダイアログが出ることになり、本当に読むべき「要修正」が埋もれる。
 */
export function needsReviewAttention(kind: ReviewVerdictKind): boolean {
  return kind === "changes-requested" || kind === "needs-check";
}
