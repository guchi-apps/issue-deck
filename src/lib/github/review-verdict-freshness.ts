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
}): ReviewVerdictFreshnessNotice | null {
  const { freshness, reviewedSha, headSha } = params;
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
  parts.push({
    text: "）。指摘が既に直っている可能性があり、修正後の再レビューの結果はまだ出ていません。",
  });
  return { freshness, parts };
}

/** 鮮度の1行を、文字列だけが要る場所（マージ確認の警告一覧）向けに組み立てる */
export function reviewVerdictFreshnessText(params: {
  freshness: ReviewVerdictFreshness;
  reviewedSha: string | null | undefined;
  headSha?: string | null;
}): string | null {
  const notice = buildReviewVerdictFreshnessNotice(params);
  return notice ? notice.parts.map((part) => part.text).join("") : null;
}
