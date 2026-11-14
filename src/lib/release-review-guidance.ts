import {
  buildCrossRepoIssueDraft,
  groupCrossRepoByRepository,
  type CrossRepoIssueDraft,
  type ReleaseReviewCrossRepoItem,
} from "@/lib/release-review-cross-repo";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/** 表示の助言。公開可否やAIの原判定を変更しない。 */
export type ReleaseGuidance = { title: string; next: string; kind: "attention" | "waiting" | "complete" };

export function describeReleaseGuidance(v: ReleaseVerificationSummary): ReleaseGuidance[] {
  const result: ReleaseGuidance[] = [];
  for (const [label, section] of [["統合検証", v.integration], ["全体レビュー", v.aiReview]] as const) {
    if (section.state === "failed") result.push({ kind: "attention", title: `${label}の実行に失敗しました`, next: label === "全体レビュー"
      ? "レビューの実行診断を開き、接続・権限・実行環境の原因を解消してから再実行してください。コードの不具合が見つかったこととは別です。"
      : "統合検証の失敗内容を開いてください。テストの不合格は修正し、設定・実行環境の不足は解消してから再検証します。" });
    else if (section.state === "invalidated" || section.state === "not_run") result.push({ kind: "attention", title: `${label}の有効な結果がありません`, next: "現在の候補を対象に検証する必要があります。下の検証詳細で依頼状態を確認してください。" });
    else if (section.state === "running" || section.state === "waiting") result.push({ kind: "waiting", title: `${label}の結果待ちです`, next: "下の実行状況を確認してください。実行中の処理を重ねて開始する必要はありません。" });
  }
  const review = v.aiReview;
  if (review.state === "needs_check" || review.state === "passed") {
    const decisions = review.decisions;
    const pending = decisions ? decisions.counts.undecidedBlocking : review.findings.length;
    if (pending > 0) result.push({ kind: "attention", title: `対応判断が必要な指摘 ${pending}件`, next: "全体レビューを開き、影響・根拠と対応案を確認してください。「今回直す」「公開後」「見送る」「不採用」を選べます。再実行だけでは指摘への判断は進みません。" });
    if (decisions && decisions.counts.fixNow > 0) result.push({ kind: "attention", title: `公開前に対応する指摘 ${decisions.counts.fixNow}件`, next: "修正の進行状況を確認してください。修正が未開始なら修正Issueを起案し、修正後の候補で再検証します。" });
    const crossRepo = crossRepoRepositories(review.crossRepoUnverified);
    if (crossRepo.length > 0) result.push({ kind: "attention", title: `他リポジトリの確認が必要です（${crossRepo.join("、")}）`, next: CROSS_REPO_NEXT });
    else if (review.unverifiedScope?.trim() || (review.state === "needs_check" && review.findings.length === 0)) result.push({ kind: "attention", title: "確認できていない範囲があります", next: "未確認の理由を開いてください。検証結果待ちなら到着後の再評価、環境不足なら環境の解消、公開後にしか確認できない作業なら実施時期の判断が必要です。同じ条件で再実行を繰り返しても解消するとは限りません。" });
  }
  if (v.integration.state === "needs_check") result.push({ kind: "attention", title: "統合検証に確認事項があります", next: "統合検証の詳細で不足している検証・設定を確認してください。AIの指摘への判断では解除されません。" });
  if (v.mac.state === "failed" || v.mac.state === "needs_setup" || v.mac.state === "invalidated") result.push({ kind: "attention", title: "iOS検証に対応が必要です", next: "iOS検証の詳細でビルドの失敗・接続や設定の不足を確認してください。" });
  if (v.mac.state === "running") result.push({ kind: "waiting", title: "iOS検証の結果待ちです", next: "iOSでのビルド確認の結果を待っています。下の詳細で進行状況を確認してください。" });
  if (result.length === 0) result.push({ kind: "complete", title: "この画面の検証に対応待ちはありません", next: "公開内容と本番公開の条件を確認してください。公開を止めない改善提案への判断は任意です。公開承認・CIなど、他の公開条件は別途確認されます。" });
  return result;
}

const CROSS_REPO_NEXT =
  "全体レビューは、この変更を使う別リポジトリのコードを読めず確認しきれませんでした。再実行・自動修正では解消しません。利用側のリポジトリで影響を確かめるIssueを起こし（下書きを出せます）、確かめた結果を判断メモに残してください。利用関係を`scripts/release-review-links.json`へ登録すると、次回から全体レビューが利用側のコードも読みます。";

function crossRepoRepositories(items: readonly ReleaseReviewCrossRepoItem[] | undefined): string[] {
  return groupCrossRepoByRepository(items ?? []).map((g) => g.repository);
}

/**
 * 指摘0件で全体レビューの要確認だけが残ったときの原因（#5378）。「自動修正では解消できません」を原因別に出し分ける。
 * 判定・ゲートは変えない（表示の助言だけ）。
 *
 * - `cross_repo`: 別リポジトリのコードが無くて確認できない。利用側への確認Issueの下書きを出す
 * - `code_unread`: 差分を読み切れていない。再実行で続きから確認する
 * - `ops`: poller更新・再起動などの運用作業の証跡待ち
 * - `evidence`: 統合検証の結果に依存する未確認
 * - `other`: 上のどれにも当たらない（読み切れなかった観点など）
 */
export type UnresolvableCause = {
  kind: "cross_repo" | "code_unread" | "ops" | "evidence" | "other";
  title: string;
  description: string;
  /** `cross_repo`のときだけ。相手リポジトリごとの確認Issueの下書き */
  drafts: CrossRepoIssueDraft[];
};

export function describeUnresolvableCause(
  verification: ReleaseVerificationSummary,
  source: { repositoryFullName: string; pullRequestNumber: number },
): UnresolvableCause {
  const review = verification.aiReview;
  const stage = review.stage;
  const items = stage?.kind === "needs_check" ? stage.items : [];
  const groups = groupCrossRepoByRepository(review.crossRepoUnverified ?? []);
  // 他リポジトリ以外の未確認が残っていれば、そちらを先に案内する（下書きを起こしても止まったままになるため）。
  // 「統合検証は成功したが未確認」は、未確認の確認項目がすべて他リポジトリが理由のものなら同じ原因として扱う
  // （利用側の未確認を「連携先」「資料」の語で書くと、証跡待ちの文言として数えられるため）
  const crossChecks = new Set((review.crossRepoUnverified ?? []).flatMap((c) => (c.checkId ? [c.checkId] : [])));
  const onlyCrossChecks = (review.review?.checks ?? []).filter((c) => c.status === "unconfirmed").every((c) => crossChecks.has(c.id));
  const others = items.filter((i) => i !== "cross_repo" && i !== "findings" && !(i === "review_unconfirmed" && onlyCrossChecks));
  if (groups.length > 0 && others.length === 0) {
    const names = groups.map((g) => g.repository).join("、");
    return {
      kind: "cross_repo",
      title: "他リポジトリの確認が必要です",
      description: `全体レビューは、この変更を使う別リポジトリ（${names}）のコードを読めず、影響を確認しきれませんでした。直すコードがこのリポジトリに無いため、再実行・自動修正では解消しません。利用側のリポジトリで影響を確かめるIssueを起こし、確かめた結果を下の「現在候補の検証」の判断メモに残してください。`,
      drafts: groups.map((g) => buildCrossRepoIssueDraft({ repository: g.repository, items: g.items, sourceRepository: source.repositoryFullName, pullRequestNumber: source.pullRequestNumber })),
    };
  }
  if (items.includes("code_unread")) {
    return {
      kind: "code_unread",
      title: "全体レビューが差分を読み切れていません",
      description: "指摘は0件ですが、確認しきれなかったファイルが残っています。直すコードが無いため修正を続けても解消しません。全体レビューを再実行すると、残りのファイルから続けて確認します。",
      drafts: [],
    };
  }
  if (items.includes("ops")) {
    return {
      kind: "ops",
      title: "運用作業の完了待ちです",
      description: "指摘は0件で、poller更新・再起動などの運用作業が済んだことを確かめられていない項目だけが残っています。作業を済ませると自動で再評価されます。修正を続けても解消しません。",
      drafts: [],
    };
  }
  if (items.some((i) => i === "evidence_failed" || i === "evidence_unavailable" || i === "evidence_waiting")) {
    return {
      kind: "evidence",
      title: "統合検証の結果に依存する未確認が残っています",
      description: "指摘は0件で、統合検証の結果（失敗・未実施・待ち）に依存する項目だけが残っています。修正を続けても解消しません。統合検証の結果を確かめてから全体レビューを再実行してください。",
      drafts: [],
    };
  }
  return {
    kind: "other",
    title: "自動修正では解消できません",
    description: `指摘は0件で、全体レビューが確認しきれなかった項目だけが残っています。直すコードが無いため、修正を続けても同じ理由で止まります。全体レビューを再実行するか、内容を確かめて判断してください。${groups.length > 0 ? `別リポジトリ（${groups.map((g) => g.repository).join("、")}）の確認も必要です。` : ""}`,
    drafts: [],
  };
}

/** AIが記録した事実を引用する入力補助。追加のAI推論・安全判定としては表示しない。 */
export function prepareFixReason(finding: ReleaseReviewFinding | undefined, blocking: boolean): string | null {
  if (!blocking || !finding?.impact?.trim() || !finding.evidence?.trim() || !finding.blockingReason?.trim()) return null;
  const excerpt = (value: string) => value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return `公開前に対応する。\n影響: ${excerpt(finding.impact)}\n根拠: ${excerpt(finding.evidence)}\n公開前に必要な理由: ${excerpt(finding.blockingReason)}`;
}
