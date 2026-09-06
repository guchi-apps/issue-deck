import type { ReviewVerdictKind } from "@/lib/github/release-verification";

/**
 * develop向けPRへ投稿された自動レビューのコメント本体を読み取る（#2849）。
 *
 * **判定だけを読む[`pull-request-review-verdict.ts`](./pull-request-review-verdict.ts)（#2843）と
 * 対になるもの。** あちらの材料はPR本文の`## 検証結果`で「何と判定されたか」までしか分からない。
 * **指摘の本文自体はアプリ内のPR詳細で読める**（`/api/pull-requests/detail`の`events`）ので、
 * 塞ぎたい穴は「読めない」ことではなく、**マージを押すのと同じカードの中で読めず、そのまま
 * 修正依頼へ渡せない**こと。develop→mainのリリース前では指摘から修正Issueを作れる（#2838・
 * `buildReleaseVerificationFixIssueDraft`）のに、その1つ手前のdevelopマージだけ指摘に対して
 * 何もできない状態だった。
 *
 * **材料はPRの会話コメント。** レビュー本体は`gh pr comment`でPRへ投稿する
 * （`.github/prompts/review-develop.md`の「## 出力」・ローカルは`scripts/prompts/review-agent.md`）。
 * 対応Issueへ投稿されるのは「自動マージを止めた理由」だけで（`merge-check-reasons.ts`が読む）、
 * 指摘の本文はIssue側には無い。
 *
 * **指摘を1件ずつのカードへ分解しない。** レビューコメントは自由記述のMarkdownで、
 * リポジトリ全体のコードレビュー（`parseCodeReviewReport`）のような`### [重大] …`の書式を
 * 持たない。分解するにはプロンプト側の出力書式を変え、全リポジトリへ`prompts-ref`を配り直す
 * 必要がある。ここは本文をそのまま読ませ、どれを直すかは読んだ人が引用から削る形にしてある。
 */

/**
 * レビュー本体が付ける総評の判定マーカー（#2448）。
 *
 * 書く側は`.github/prompts/review-develop.md`と`scripts/prompts/review-agent.md`、
 * 読む側は`reusable-claude-review-develop.yml`（PR本文の節を書く）・
 * `reusable-release-develop-to-main.yml`（リリースPRの表）・ここ。
 * **`scripts/check-review-verdict-marker.sh`がCIで書式を突き合わせる**ので、
 * 文字列を変えるときはその一覧にも入れること。
 */
const VERDICT_MARKER_PATTERN =
  /<!--\s*issue-deck-review-verdict:(lgtm|needs-check|changes-requested)\s+sha=([0-9a-fA-F]+)\s*-->/;

/**
 * レビュー本体が投稿できなかったときに、ワークフローが実行ログから転記したコメントの印（#2488）。
 *
 * **転記には判定マーカーが付かない**（レビューしていない判定を作らないため）。本文は読めるので
 * 判定`unknown`として拾う——「レビューはあるが判定が残っていない」を「レビューが無い」と
 * 同じ扱いにすると、指摘が画面から消える。
 */
const REPORT_MARKER_PATTERN = /<!--\s*issue-deck-review-report\s+sha=([0-9a-fA-F]+)\s*-->/;

/** マーカーの値と画面の判定の対応。`lgtm`だけ語が違うのは、判定の語彙が画面側で共通のため */
const VERDICT_KINDS: Readonly<Record<string, ReviewVerdictKind>> = {
  lgtm: "ok",
  "needs-check": "needs-check",
  "changes-requested": "changes-requested",
};

/**
 * 判定ごとの文言。**PR本文の節・リリースPRの表と同じ言い回しにする**（記号は`VerdictText`が
 * 付けるので、ここには入れない）。
 */
export const REVIEW_COMMENT_VERDICT_LABEL: Readonly<Record<ReviewVerdictKind, string>> = {
  ok: "問題なし（LGTM）",
  "needs-check": "要確認",
  "changes-requested": "要修正",
  skipped: "実施なし",
  unknown: "判定の記録なし",
};

/** 本文から落とすHTMLコメント行（マーカー類）。読み手に見えないうえ、引用へ持ち込むと紛らわしい */
const MARKER_LINE_PATTERN = /^\s*<!--.*-->\s*$/;

export type PullRequestReviewCommentSource = {
  body: string | null;
  createdAt: string;
  /** そのコメントのURL。「GitHubで読む」の行き先に使う。取れなければnull */
  htmlUrl: string | null;
};

export type PullRequestReviewCommentContent = {
  verdictKind: ReviewVerdictKind;
  /** 判定の文言（`REVIEW_COMMENT_VERDICT_LABEL`） */
  verdictLabel: string;
  /** マーカー行を落とした本文。空になることはない（空ならそのコメントは採らない） */
  body: string;
  createdAt: string;
  htmlUrl: string | null;
  /** レビューしたコミット。マーカーから読めなければnull */
  reviewedSha: string | null;
  /**
   * PRのheadより古いコミットへのレビューか。
   *
   * **`reviewedSha`が読めないときはfalse**（＝古いとは言わない）。転記されたコメントには
   * `sha=`が入るが、将来書式が変わって読めなくなったときに「古い」と言い切ると、
   * 実際には最新のレビューへ注意書きが付く。
   */
  isStale: boolean;
};

/** そのコメントがレビュー本体のものか。判定マーカーか転記の印のどちらかを持つ */
function matchMarkers(body: string): { kind: ReviewVerdictKind; sha: string } | null {
  const verdict = VERDICT_MARKER_PATTERN.exec(body);
  if (verdict) {
    return { kind: VERDICT_KINDS[verdict[1]] ?? "unknown", sha: verdict[2] };
  }
  const report = REPORT_MARKER_PATTERN.exec(body);
  if (report) {
    return { kind: "unknown", sha: report[1] };
  }
  return null;
}

/** マーカー行を落とし、前後の空行を詰める */
function stripMarkers(body: string): string {
  return body
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !MARKER_LINE_PATTERN.test(line))
    .join("\n")
    .trim();
}

/**
 * PRの会話コメントから、いま読むべきレビューコメントを1件選ぶ。1件も無ければnull。
 *
 * **選ぶのは「headと同じコミットへのレビューのうち最後のもの」。** 同じPRには実装者・
 * 自動修復・fallbackのコメントも並ぶため、投稿者では絞れない（ローカルのレビュー・統合
 * エージェントはユーザー本人のトークンで投稿する）。追いコミットで複数回レビューされている
 * 場合、いまの中身に対する判定は最後のものになる。
 *
 * **headと一致するものが無ければ、最後のレビューを`isStale`付きで返す。** 隠すと
 * 「レビューが無い」と区別が付かず、直前のレビューで何を言われたのかを読めないままマージを
 * 押すことになる。古いことは画面側が先に言う。
 */
export function selectPullRequestReviewComment(
  comments: readonly PullRequestReviewCommentSource[],
  headSha: string | null,
): PullRequestReviewCommentContent | null {
  const found: (PullRequestReviewCommentContent & { matchesHead: boolean })[] = [];

  for (const comment of comments) {
    if (!comment.body) continue;
    const marker = matchMarkers(comment.body);
    if (!marker) continue;
    const body = stripMarkers(comment.body);
    if (body === "") continue;

    const matchesHead = headSha !== null && marker.sha.toLowerCase() === headSha.toLowerCase();
    found.push({
      verdictKind: marker.kind,
      verdictLabel: REVIEW_COMMENT_VERDICT_LABEL[marker.kind],
      body,
      createdAt: comment.createdAt,
      htmlUrl: comment.htmlUrl,
      reviewedSha: marker.sha,
      isStale: headSha !== null && !matchesHead,
      matchesHead,
    });
  }

  if (found.length === 0) return null;

  const latestForHead = [...found].reverse().find((item) => item.matchesHead);
  const selected = latestForHead ?? found[found.length - 1];
  return {
    verdictKind: selected.verdictKind,
    verdictLabel: selected.verdictLabel,
    body: selected.body,
    createdAt: selected.createdAt,
    htmlUrl: selected.htmlUrl,
    reviewedSha: selected.reviewedSha,
    isStale: selected.isStale,
  };
}

/**
 * 「気になった点」の見出し。レビューの出力はこの順で書くよう指示してある
 * （`.github/prompts/review-develop.md`の「## 出力」: 総評 → 気になった点 → 自動マージ可否）。
 *
 * **見出しの深さも記法も揃っていない**（実物には`## 気になった点`・`### 気になった点`・
 * `**気になった点**`がある）ので、行の中に語があるかどうかだけを見る。
 */
const CONCERNS_HEADING_PATTERN = /^\s{0,3}(#{1,6}\s|\*\*)\s*.*気になった点/;

/**
 * 取り込む範囲を、レビュー本文の「気になった点」以降へ絞る（#2849）。見出しが無ければ本文全部。
 *
 * **総評と「良かった点」まで引用へ持ち込まない。** 直させたいのは指摘であって講評ではなく、
 * 実物のレビューは前半に「確認した範囲」「良かった点」を数十行書く。全部を渡すと、修正依頼の
 * 大半が直す必要のない文章になる（何を直すのかを人が読み取れず、受け取る側も同じ）。
 * **判定そのものは引用の前の1行に書いてある**ので、総評を落としても文脈は残る。
 *
 * **見出しが読めなければ全部を渡す。** 書式は自由記述なので、絞れなかったときに空を返すより、
 * 多いまま渡して人に削らせる方が安全。
 */
export function extractReviewConcerns(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => CONCERNS_HEADING_PATTERN.test(line));
  if (start < 0) return body;
  return lines.slice(start).join("\n").trim();
}

/** 取り込む引用に載せる本文の上限。これを超えたら切って、続きはGitHubで読ませる */
const QUOTE_MAX_LINES = 60;
const QUOTE_MAX_CHARS = 4000;

/**
 * レビュー本文を、修正依頼欄へそのまま入れられる文面に組み立てる（#2849）。
 *
 * **押した時点ではGitHubへ何も送らない。** 入るのは画面のテキスト欄までで、送るかどうか・
 * どの指摘を残すかは読んだ人が決める（リリース前の「修正をIssueにする」が、押しても起票せず
 * 埋めたダイアログを開くだけなのと同じ立場）。
 *
 * **本文は引用（`> `）にする。** レビューは自由記述のMarkdownで、見出しも箇条書きも入る。
 * 素のまま入れると、送った後のIssueコメントを見出しで区切って読む相手（無人実行の
 * `## 前提条件`の切り出しなど）がレビューの書きぶりで変わってしまう。
 */
export function buildReviewFixRequestText(params: {
  review: Pick<PullRequestReviewCommentContent, "body" | "verdictLabel">;
  pullRequestNumber: number;
}): string {
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;

  for (const line of extractReviewConcerns(params.review.body).split("\n")) {
    if (lines.length >= QUOTE_MAX_LINES || chars + line.length + 1 > QUOTE_MAX_CHARS) {
      truncated = true;
      break;
    }
    chars += line.length + 1;
    lines.push(line === "" ? ">" : `> ${line}`);
  }

  const quoted = lines.join("\n");
  const head =
    `自動レビュー（PR #${params.pullRequestNumber}・${params.review.verdictLabel}）で` +
    "指摘された次の点を修正してください。";
  const tail = truncated
    ? "\n>\n> （長いため以降を省略しました。全文はPRのレビューコメントにあります）"
    : "";

  return `${head}\n\n${quoted}${tail}\n`;
}

/**
 * どのPRのレビューを読むか（#2849）。openでマージ済みでないPRのうち、いちばん番号が小さいもの。
 *
 * **1つのIssueに対応PRが複数ぶら下がることがある**（#1339。修復用のPRなど）。マージ待ちの
 * カードはそれらを行として並べるが、レビューの指摘は「これからdevelopへ入るPR」のものだけを
 * 読ませたい。closedとdraftを外し、残りのうち先に作られた（＝番号が小さい）ものを選ぶ。
 * 該当が無ければnullで、パネルそのものを出さない。
 */
export function selectReviewTargetPullRequestNumber(
  pullRequests: readonly { number: number; state: "open" | "closed"; merged: boolean; draft: boolean }[],
): number | null {
  const open = pullRequests
    .filter((pullRequest) => pullRequest.state === "open" && !pullRequest.merged && !pullRequest.draft)
    .map((pullRequest) => pullRequest.number)
    .sort((a, b) => a - b);
  return open[0] ?? null;
}
