/**
 * リリース全体レビュー（#4238）の確認項目（#4559）。**何を確認すれば合格なのか**をコードに固定する。
 *
 * 項目を足す・文言を変えるときは`RELEASE_REVIEW_CHECKLIST_VERSION`を上げる。版が変わると、前回の
 * 確認結果は再レビューへ引き継げない（全体確認へ戻る。`release-review-context.ts`）。
 * 項目ごとの結果は「確認済み／非該当／未確認」と根拠で、**根拠の無い確認済みは未確認として扱う**。
 */
export const RELEASE_REVIEW_CHECKLIST_VERSION = 1;

export type ReleaseReviewCheckItem = {
  id: string;
  label: string;
  /** レビュー担当へ渡す、確認する観点の説明 */
  guide: string;
};

export const RELEASE_REVIEW_CHECK_ITEMS: readonly ReleaseReviewCheckItem[] = [
  {
    id: "pr_interaction",
    label: "複数PRの相互作用・呼び出し元・API・スキーマの整合",
    guide:
      "同じ箇所への相反する変更、片方だけ反映された変更、関数・API・スキーマ変更に対する呼び出し元の更新漏れ。",
  },
  {
    id: "auth_boundary",
    label: "認証・認可と利用者／リポジトリ間のデータ境界",
    guide: "認証・認可の抜け、他の利用者・他のリポジトリのデータへ届く経路、シークレットの扱い。",
  },
  {
    id: "host_compat",
    label: "実行ホスト（アプリ・サブPC poller・Mac）と共有ワークフローの新旧互換性・配布条件",
    guide:
      "サーバーだけ先に出た／pollerだけ古いときの動作、共有ワークフローのタグ参照と配布条件、実行ホストへ届くスクリプトの更新。",
  },
  {
    id: "config_migration",
    label: "設定・環境変数・データ移行・機能有効化の前提と適用順序",
    guide: "必要な環境変数・シークレット・マイグレーション・デプロイ設定の不足と、適用する順序。",
  },
  {
    id: "state_consistency",
    label: "候補固定・修正の取り込み・再試行／重複実行／途中失敗時の状態整合",
    guide: "同じ処理が2回走る・途中で止まる・順序が入れ替わるときに、記録と実状態が食い違わないか。",
  },
  {
    id: "ui_truthfulness",
    label: "画面の状態・操作案内・更新履歴が、実際の処理と利用可能な機能に一致すること",
    guide: "画面の文言・ボタン・更新履歴が、実際には動かない／まだ使えない機能を案内していないか。",
  },
];

export const RELEASE_REVIEW_CHECK_ITEM_IDS: readonly string[] = RELEASE_REVIEW_CHECK_ITEMS.map((i) => i.id);

export type ReleaseReviewCheckStatus = "confirmed" | "not_applicable" | "unconfirmed";
/** `current`は今回の対象に対して確認した結果、`carried_over`は前回の結果を引き継いだもの */
export type ReleaseReviewCheckSource = "current" | "carried_over";

export type ReleaseReviewCheckResult = {
  id: string;
  status: ReleaseReviewCheckStatus;
  /** 根拠（確認した箇所・非該当の理由）。未確認のときは未確認の理由 */
  evidence: string | null;
  source: ReleaseReviewCheckSource;
  /** 引き継いだ結果が出た対象のhead（`carried_over`のときだけ）。旧SHAの結果を現SHAの結果へ書き換えない */
  carriedFromHeadSha: string | null;
};

export function checkItemLabel(id: string): string {
  return RELEASE_REVIEW_CHECK_ITEMS.find((i) => i.id === id)?.label ?? id;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

/** 前回の結果のうち、今回へ引き継げる状態（確認済み・非該当）か */
function isCarryableStatus(status: ReleaseReviewCheckStatus | undefined): boolean {
  return status === "confirmed" || status === "not_applicable";
}

export type NormalizeCheckInput = {
  raw: unknown;
  /** 引き継ぎを許してよいか。許さないときは`carried_over`の申告を未確認にする */
  carryOverAllowed: boolean;
  /** 前回の結果（項目ID→前回の状態）と、その対象のhead */
  previous?: { headSha: string; statuses: Record<string, ReleaseReviewCheckStatus> } | null;
};

/**
 * 報告された項目別の結果を、定義済みの全項目ぶんへ揃える。**報告の無い項目・根拠の無い確認は
 * 未確認にする**（プロンプトへ差分を載せただけで「確認済み」にしない）。引き継ぎは、サーバーが
 * 前回の記録で確認済み／非該当だと確かめた項目にだけ認める（AIの自己申告を信じない）。
 */
export function normalizeCheckResults(input: NormalizeCheckInput): ReleaseReviewCheckResult[] {
  const reported = new Map<string, Record<string, unknown>>();
  if (Array.isArray(input.raw)) {
    for (const entry of input.raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const id = text(rec.id, 64);
      if (id && RELEASE_REVIEW_CHECK_ITEM_IDS.includes(id) && !reported.has(id)) reported.set(id, rec);
    }
  }
  return RELEASE_REVIEW_CHECK_ITEMS.map((item): ReleaseReviewCheckResult => {
    const rec = reported.get(item.id);
    const unconfirmed = (reason: string): ReleaseReviewCheckResult => ({
      id: item.id,
      status: "unconfirmed",
      evidence: reason,
      source: "current",
      carriedFromHeadSha: null,
    });
    if (!rec) return unconfirmed("この項目の確認結果が報告されていません");
    const status =
      rec.status === "confirmed" || rec.status === "not_applicable" || rec.status === "unconfirmed"
        ? rec.status
        : null;
    if (!status) return unconfirmed("確認結果の形式が不正です");
    const evidence = text(rec.evidence, 1500);
    if (status === "unconfirmed") return unconfirmed(evidence ?? "未確認の理由が報告されていません");
    if (!evidence) return unconfirmed(`根拠が無いため${status === "confirmed" ? "確認済み" : "非該当"}として扱えません`);
    if (rec.source === "carried_over") {
      const prev = input.previous;
      if (!input.carryOverAllowed || !prev) return unconfirmed("前回の結果を使える条件ではないため、引き継ぎを認めません");
      if (!isCarryableStatus(prev.statuses[item.id])) return unconfirmed("前回この項目が確認済みではないため、引き継ぎを認めません");
      return { id: item.id, status, evidence, source: "carried_over", carriedFromHeadSha: prev.headSha };
    }
    return { id: item.id, status, evidence, source: "current", carriedFromHeadSha: null };
  });
}

/** 未確認の項目を、確認できなかった範囲の文言へ。無ければnull */
export function describeUnconfirmedChecks(results: readonly ReleaseReviewCheckResult[]): string | null {
  const open = results.filter((r) => r.status === "unconfirmed");
  if (open.length === 0) return null;
  return `確認項目${open.length}件が未確認です（${open.map((r) => checkItemLabel(r.id).split("・")[0]).join("、")}）`;
}

/** プロンプトへ入れる確認項目の一覧 */
export function checklistPromptText(): string {
  return RELEASE_REVIEW_CHECK_ITEMS.map((i) => `- \`${i.id}\` ${i.label}: ${i.guide}`).join("\n");
}

/**
 * リリースを止める指摘と止めない改善提案の区別（全体レビューと、修正セッション内の独立レビューで同じ基準を使う）。
 */
export const BLOCKING_POLICY_LINES: readonly string[] = [
  "リリースを止める指摘（blocking）: セキュリティ、データ破損、主要機能の破綻、必須の配布・移行の欠落など、利用者または本番へ具体的な実害がある問題。severityの名前ではなく、実害・根拠・判定理由で決める。実害のある問題を「軽微」として回避しない。",
  "止めない改善提案（non-blocking）: 好み・推測・変更前からある問題・実害のない改善案。リリースは止めず、別Issueで追跡する対象。",
  "公開前と公開後を分ける（#4657）: mainへの公開後にしか実施・確認できない作業（共有ワークフローのタグ配布・フリートへの配布、本番でのmigration適用の成功確認など）を、同じ本体の公開前の完了条件にしない（循環して公開できなくなる）。それらは「公開後の作業」として指摘し、何を・いつ確かめるかを書く。一方で、公開前に確かめられる移行の互換性・適用順序・手順・必要な設定の欠落は、従来どおり止める指摘にする。",
  "指摘には、具体的な影響・根拠・公開前に必要な理由を書く。重大度が高いことだけを止める理由にしない（採否と対応時期はユーザーが判断する）。",
];
