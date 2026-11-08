/**
 * 自動レビューの判定が「いまのコミットに対するものか」を決める（#3172）。
 *
 * **判定は残るが、コミットは進む。** PR本文の`## 検証結果`は自動レビューが走るたびに
 * 書き換わる一方で、指摘を直すコミットを積んでから次のレビューが終わるまでのあいだ、
 * 画面には前回の「要修正」がそのまま出ていた。修正前の話をしているのか、直したうえで
 * まだ直っていないと言われているのかが読めないため、判定と一緒に残したコミット
 * （`sha=`）をPRのheadと突き合わせて、その1行を画面へ出す。
 *
 * **材料は2つとも取得済みのもので、GitHub APIの消費は増えない。** 判定時点のSHAは
 * PR本文のマーカー（`parsePullRequestReviewVerdict`）か、PR詳細が既に持っている
 * レビューコメントのマーカー（`selectPullRequestReviewComment`）から読む。headのSHAは
 * 一覧・詳細のどちらの経路も返している`PullRequestSummary.headSha`。
 *
 * **「待てば更新されるのか」まで言う。** 追いコミットの直後は再レビューが走っていることが
 * ほとんど（callerは`synchronize`で起動し、検証結果の節は`if: always()`で毎回置き換わる）で、
 * そのあいだは同じ画面が「Claudeがレビュー中」とも言っている。走っているかどうかを判定に
 * 渡さないと、待てば消える表示と、待っても変わらない表示が同じ文面になる（`isReviewing`）。
 *
 * **`unknown`を「古い」へ倒さない。** この変更より前に書かれたPRの本文・共有ワークフローの
 * タグが配られていないリポジトリのPRには`sha=`が無い。分からないときに「この判定は古い
 * かもしれません」と書くと、最新のレビューにまで注意書きが付いて、本当に古いときの1行が
 * 効かなくなる（`selectPullRequestReviewComment`の`isStale`が同じ理由でfalseへ倒すのと同じ）。
 */

/** 判定の鮮度。`unknown`＝判定時点のコミットが記録されていない（画面には何も出さない） */
export type ReviewVerdictFreshness = "current" | "stale" | "unknown";

/** 画面に出す1行の断片。`mono`はコミットのSHAで、等幅で描く */
export type ReviewVerdictFreshnessPart = { text: string; mono?: boolean };

export type ReviewVerdictFreshnessNotice = {
  freshness: Exclude<ReviewVerdictFreshness, "unknown">;
  parts: ReviewVerdictFreshnessPart[];
};

/**
 * 再レビュー（判定ワークフローのレビュー系ジョブ）の進み具合（#5210）。headのcheck-runから読むので、
 * 古いコミットのrunは混ざらない。
 *
 * - `queued` … 始まっていない（待ち行列・前段のジョブ待ち）
 * - `running` … 実行中
 * - `completed` … ジョブは終わった。**判定が書かれたとは限らない**（鮮度は別に見る）
 * - `stalled` … runは終わったのにジョブが未完了のまま残っている。待っても進まない
 * - `not-run` … レビューの前段のジョブが失敗し、レビュー自体が走らないまま終わった（#5212）。
 *   レビュー本体のジョブが途中で失敗し、判定が出ないまま終わった場合も含む（#5261）
 */
export type ReviewRunProgress = "queued" | "running" | "completed" | "stalled" | "not-run";

/**
 * レビューが実行されないまま判定ワークフローが止まった原因のジョブ（#5212）。
 *
 * `claude-review`の`skipped`には「差分が小さいので省略した」（設計どおり）と「前段が止まって
 * 走れなかった」の2つの意味があり、結論だけでは区別できない。前段のジョブの状態から後者だけを取り出す。
 */
export type ReviewStopped = {
  /** 止まったジョブの名前（`review-provider`など） */
  job: string;
  /** `stalled`＝実行機に割り当てられないまま終わった・`failed`＝失敗した */
  reason: "stalled" | "failed";
  /** そのジョブの実行ログのURL。取れなければnull */
  url: string | null;
};

const REVIEW_STOPPED_JOB_LABEL: Readonly<Record<string, string>> = {
  "review-provider": "レビュー担当を決めるジョブ（review-provider）",
  "risk-check": "リスクを判定するジョブ（risk-check）",
  "claude-review": "レビューのジョブ（claude-review）",
  "codex-review": "レビューのジョブ（codex-review）",
};

/** レビューを実際に行うジョブ。前段（`risk-check`・`review-provider`）と分ける */
const REVIEW_EXECUTOR_JOBS: ReadonlySet<string> = new Set(["claude-review", "codex-review"]);

/**
 * レビュー本体のジョブが走ったうえで失敗したか（#5261）。前段が止まってレビューが走らなかった
 * （「未実施」）のと区別し、画面では「レビュー失敗」と呼ぶ。
 */
export function isReviewExecutorFailure(stopped: ReviewStopped | null | undefined): boolean {
  return stopped?.reason === "failed" && REVIEW_EXECUTOR_JOBS.has(stopped.job);
}

/** レビューが走らなかった理由の1文。代表状態・マージ確認・見込みで同じ言葉を使う */
export function reviewStoppedReason(stopped: ReviewStopped): string {
  const job = REVIEW_STOPPED_JOB_LABEL[stopped.job] ?? `ジョブ（${stopped.job}）`;
  if (stopped.reason === "stalled") return `${job}が実行機に割り当てられないまま、実行が終わりました。待っても進みません`;
  if (isReviewExecutorFailure(stopped)) return `${job}が途中で失敗し、判定が出ませんでした`;
  return `${job}が失敗し、レビューが実行されませんでした`;
}

/**
 * いまのコミットのレビューが実施されていないか（#5212）。原因のジョブが分かっていて、かつ
 * いまのコミットに対する判定が残っていないとき。同じコミットの判定があれば、それは有効な判定として扱う。
 */
export function isReviewNotRun(params: {
  reviewStopped: ReviewStopped | null | undefined;
  reviewedSha: string | null | undefined;
  headSha: string | null | undefined;
}): boolean {
  return (
    Boolean(params.reviewStopped) &&
    resolveReviewVerdictFreshness({ reviewedSha: params.reviewedSha, headSha: params.headSha }) !== "current"
  );
}

/** 再レビューの進み具合の短い文言。`null`はheadにレビューのrunが1件も見えていない */
export function reviewProgressLabel(progress: ReviewRunProgress | null | undefined): string {
  switch (progress) {
    case "queued":
      return "待ち行列（まだ始まっていません）";
    case "running":
      return "実行中";
    case "completed":
      return "完了（最新のコミットへの判定は記録されていません）";
    case "stalled":
      return "停止（実行が終わったのにレビューのジョブが完了していません）";
    case "not-run":
      return "未実施（ジョブが失敗し、新しい判定は出ていません）";
    default:
      return "開始を確認できていません";
  }
}

/** 古い判定を指す短い名前。代表状態・コードの行・レビューの行で同じ言葉を使う */
export function staleVerdictLabel(progress: ReviewRunProgress | null | undefined): string {
  switch (progress) {
    case "queued":
      return "古い判定（再レビュー待ち）";
    case "running":
      return "古い判定（再レビュー中）";
    case "completed":
      return "古い判定（新しい判定なし）";
    case "stalled":
      return "古い判定（再レビュー停止）";
    case "not-run":
      return "古い判定（再レビュー未実施）";
    default:
      return "古い判定（再レビュー未開始）";
  }
}

/** 待っていても新しい判定が出ないと分かっているか。人が再実行するかを判断する状態 */
export function reviewRerunNeeded(progress: ReviewRunProgress | null | undefined): boolean {
  return progress === "completed" || progress === "stalled" || progress === "not-run";
}

/** 画面に出すコミットの短縮形。GitHubの表示と同じ7桁 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * 判定時点のコミットとheadを突き合わせる。どちらかが分からなければ`unknown`。
 *
 * 大文字小文字は揃えて比べる——マーカーを書くのはワークフロー（`${HEAD_SHA}`）と
 * レビュー・統合エージェント（人が貼る）の両方で、揃っている保証が無い。
 */
export function resolveReviewVerdictFreshness(params: {
  reviewedSha: string | null | undefined;
  headSha: string | null | undefined;
}): ReviewVerdictFreshness {
  const { reviewedSha, headSha } = params;
  if (!reviewedSha || !headSha) return "unknown";
  return reviewedSha.toLowerCase() === headSha.toLowerCase() ? "current" : "stale";
}

/**
 * 鮮度の1行を組み立てる。`unknown`ならnull（何も出さない）。
 *
 * **headのSHAは省略できる。** Issue詳細のレビュー指摘パネル（`PullRequestReviewFindings`）は
 * 古いかどうかだけを受け取っていて（`isStale`）、headのSHAを持たない。そこでは判定時点だけを
 * 添えた短い文にする。
 */
export function buildReviewVerdictFreshnessNotice(params: {
  freshness: ReviewVerdictFreshness;
  reviewedSha: string | null | undefined;
  headSha?: string | null;
  isReviewing?: boolean;
  /** 再レビューの進み具合（#5210）。分かるときは`isReviewing`より優先する */
  reviewProgress?: ReviewRunProgress | null;
}): ReviewVerdictFreshnessNotice | null {
  const { freshness, reviewedSha, headSha, isReviewing = false, reviewProgress } = params;
  if (freshness === "unknown" || !reviewedSha) return null;

  if (freshness === "current") {
    return {
      freshness,
      parts: [
        { text: "最新のコミット " },
        { text: shortSha(reviewedSha), mono: true },
        { text: " に対する判定です。" },
      ],
    };
  }

  const parts: ReviewVerdictFreshnessPart[] = [
    { text: "この判定の後にコミットが積まれています（判定時点 " },
    { text: shortSha(reviewedSha), mono: true },
  ];
  if (headSha) {
    parts.push({ text: " → 最新 " }, { text: shortSha(headSha), mono: true });
  }
  // **待てば更新されるのかどうかまで言う。** 追いコミットの直後は再レビューが走っている
  // ことがほとんど（callerは`synchronize`で起動し、節は毎回置き換わる）で、そのあいだは
  // 同じ画面が「Claudeがレビュー中」とも言っている。走っていないときに同じ文を出すと、
  // 待っても変わらない判定を待たせることになる
  parts.push({
    text: reviewProgress
      ? `）。指摘が既に直っている可能性があります。再レビュー: ${reviewProgressLabel(reviewProgress)}。`
      : isReviewing
        ? "）。いま最新のコミットをレビューし直しています。"
        : "）。指摘が既に直っている可能性がありますが、修正後の再レビューは走っていません。",
  });
  return { freshness, parts };
}

/** 鮮度の1行を、文字列だけが要る場所（マージ確認の警告一覧）向けに組み立てる */
export function reviewVerdictFreshnessText(params: {
  freshness: ReviewVerdictFreshness;
  reviewedSha: string | null | undefined;
  headSha?: string | null;
  isReviewing?: boolean;
}): string | null {
  const notice = buildReviewVerdictFreshnessNotice(params);
  return notice ? notice.parts.map((part) => part.text).join("") : null;
}
