/**
 * 本番デプロイ失敗の帯から起こす「修正Issue」の下書き（#3887）。
 *
 * 自動起票のデプロイ失敗Issue（`[デプロイ失敗]`）は#3895で廃止した。ここに残すのは、人が帯の
 * 「修正Issueを作成」を押したときに開く新規作成ダイアログの下書きだけで、起票はしない。
 */

import { deployFailureKindLabel, isMigrationFailureKind, type DeployFailureClassification } from "@/lib/deploy-failure-kind";

/** 修正Issueのタイトル接頭辞 */
export const DEPLOY_FAILURE_FIX_TITLE_PREFIX = "[デプロイ失敗の修正]";

export type DeployFailureFixIssueDraft = {
  repositoryFullName: string;
  title: string;
  body: string;
};

/** `https://github.com/o/r/actions/runs/123`から123を取る。読めなければnull */
export function parseRunIdFromRunUrl(runUrl: string | null | undefined): number | null {
  const match = runUrl?.match(/\/actions\/runs\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * 帯の「修正Issueを作成」が開く新規作成ダイアログの下書き（#3887）。**ここでは起票しない。**
 * AIの分析があれば推定原因とログ抜粋を本文へ入れる（無ければ実行へのリンクだけ）。
 */
export function buildDeployFailureFixIssueDraft(params: {
  repositoryFullName: string;
  version: string | null;
  runUrl: string | null;
  failedJobs: readonly string[];
  analysis: { cause: string; excerpt: string; advice: string | null } | null;
}): DeployFailureFixIssueDraft {
  const { repositoryFullName, version, runUrl, failedJobs, analysis } = params;
  const lines = [
    `- 対象: ${repositoryFullName}${version ? ` v${version}` : ""}`,
    ...(runUrl ? [`- 失敗した実行: ${runUrl}`] : []),
    ...(failedJobs.length > 0 ? [`- 失敗したジョブ: \`${failedJobs.join("`, `")}\``] : []),
  ];
  const sections = [
    `## 何が起きているか\n\n本番デプロイ（\`deploy.yml\`）が失敗し、再デプロイでは直らないため、コードか設定の修正が要ります。\n\n${lines.join("\n")}`,
  ];
  if (analysis) {
    sections.push(
      `## AIによる原因の推定\n\n${analysis.cause}${analysis.advice ? `\n\n直し方の提案: ${analysis.advice}` : ""}\n\n※ログ末尾からの推定です。実行ログで確かめてから直してください。`,
    );
    if (analysis.excerpt) {
      sections.push(`## ログの抜粋\n\n\`\`\`\n${analysis.excerpt}\n\`\`\``);
    }
  }
  sections.push("## 完了条件\n\n- 修正をdevelopへ入れ、次の本番デプロイが成功すること");
  return {
    repositoryFullName,
    title: `${DEPLOY_FAILURE_FIX_TITLE_PREFIX} ${version ? `v${version}の` : ""}本番デプロイが失敗する原因を直す`,
    body: sections.join("\n\n"),
  };
}

/**
 * 「AIに修正を依頼」（#3998）が作る修正Issueの本文。下書き（`buildDeployFailureFixIssueDraft`）と違い、
 * **実装セッションへの指示を兼ねる**——原因の区分を最初に報告させ、コード以外ならPRを作らせない。
 * 区分の報告はIssueコメントのマーカーで受け、巡回（`deploy-recovery-series-run.ts`）が読む。
 */
export function buildDeployRecoveryIssueSection(params: {
  seriesMarker: string;
  failedSha: string;
  failedRunUrl: string;
  failedRunAttempt: number;
  failedJobs: readonly string[];
  runningSha: string | null;
  logExcerpt: string | null;
  /** ログ全文からの失敗の種類の判別（#5632）。読めなければnull */
  failureKind?: DeployFailureClassification | null;
  causeMarkerPrefix: string;
  /** 修正済みのPR番号を報告するマーカーの接頭辞。無ければ`already_fixed`の案内を出さない */
  fixPrMarkerPrefix?: string;
  /** 開始者が許可した範囲。`fix_until_main`ならmainへの反映も自動で進む */
  throughMain?: boolean;
}): string {
  const facts = [
    `- 失敗した実行: ${params.failedRunUrl}（attempt ${params.failedRunAttempt}）`,
    `- 失敗したコミット: \`${params.failedSha}\``,
    `- 直近に本番デプロイが成功したコミット: ${params.runningSha ? `\`${params.runningSha}\`` : "不明"}`,
    ...(params.failedJobs.length > 0 ? [`- 失敗したジョブ: \`${params.failedJobs.join("`, `")}\``] : []),
  ];
  const marker = (cause: string) => `\`<!-- ${params.causeMarkerPrefix}${cause} -->\``;
  const kind = params.failureKind ?? null;
  const migration = kind !== null && isMigrationFailureKind(kind.kind);
  const kindLines =
    kind === null
      ? []
      : [
          "### ログからの判別（機械判定・手掛かり）",
          "",
          `- 種類: ${deployFailureKindLabel(kind.kind)}`,
          ...(kind.migrationName ? [`- マイグレーション: \`${kind.migrationName}\``] : []),
          ...(kind.failedQueryNumber !== null ? [`- 失敗した文: マイグレーションの${kind.failedQueryNumber}番目の文`] : []),
          ...(kind.evidence ? [`- 根拠: \`${kind.evidence.replace(/`/g, "'")}\``] : []),
          "- 種類ごとの切り分けと次の一手: issue-deckの`docs/deploy-recovery-runbook.md`",
          "",
        ];
  // 判別は手掛かりで、ログが読めない・判別を外すこともあるため、扱いの節は常に出す。
  // マイグレーションの失敗と判別できたときだけ、節を指示の手前に置いて先に読ませる。
  const migrationGuideLines = [
    "",
    "### マイグレーションの失敗の扱い",
    "",
    "失敗したマイグレーションは本番DBの`_prisma_migrations`に「失敗」として残り、残っている間は以降のデプロイが毎回P3009で止まる。gate経由のデプロイではシェルを取れないため、**記録の解消もコードとして本番へ出す**。区分は`database`ではなく次の2つで報告する。",
    "",
    `- 自動で解消してよい: ${marker("migration")}。マイグレーションの修正と、失敗の記録を解消する \`deploy/pre-migrate.sh\`（gateが\`prisma migrate deploy\`の直前に実行する。\`prisma migrate resolve --rolled-back <名前>\`で記録を外す）を**同じ修正PR**に入れる。mainに既にあれば、それが今回のマイグレーションに効くか（名前の決め打ちになっていないか）を確かめ、効かなければ直して同じPRに入れる。報告コメントに、解消手段がどこにあり今回の失敗に効く理由を書く`,
    `- 途中まで適用されている恐れがある: ${marker("migration_unsafe")}。**コミットもPRも作らない。** 自動で記録を外して再適用すると、残った変更とぶつかるか二重に適用される`,
    "",
    "部分適用の判定材料: 失敗したマイグレーションのSQLで、**失敗した文より前に、スキーマかデータを変える文があるか**（MySQL/MariaDBのDDLは文ごとに自動コミットされ、失敗しても前の文は残る）。P3009のログには失敗した文が出ないため、最初に失敗した実行（P3018）のログの「query number N」を読む（Actionsの履歴から同じマイグレーション名で探す）。**そのログが見つからないときは**、リポジトリのマイグレーションSQLが1文だけか、全文が冪等（`IF NOT EXISTS`・存在確認つき）のときだけ`migration`とし、それ以外は`migration_unsafe`に倒す。前の文が無い（1番目の文で失敗）、または修正版がその文を適用済みの状態でも通る（冪等）なら`migration`、それ以外・判断できないときは`migration_unsafe`。`migration_unsafe`の報告には、確認すべき本番の状態（表・列・インデックス）と、人が取る最小の操作を書く",
  ];
  return [
    "## 本番復旧の自動化（AIに修正を依頼）",
    "",
    "このIssueはデプロイ失敗の帯の「AIに修正を依頼」から作られました。issue-deckが原因の区分・修正PR・CI・レビューを追跡します。",
    "",
    ...facts,
    "",
    ...kindLines,
    ...(migration ? [...migrationGuideLines.slice(1), ""] : []),
    "### 実装セッションへの指示",
    "",
    "1. **最初に**実行ログ・失敗工程・失敗したコミットまでの変更・本番で動いている版を確かめて原因を調べ、区分を次のマーカーのどれか1つを含むIssueコメントで報告する。ログ末尾の推定だけで決めない",
    `   - コードの修正で直る: ${marker("code")}`,
    ...(params.fixPrMarkerPrefix
      ? [
          `   - 原因はすでにdevelopで修正済みで、コードを変える必要が無い（候補へ未反映、履歴だけの競合など）: ${marker("already_fixed")} と、修正済みのPR番号 \`<!-- ${params.fixPrMarkerPrefix}<PR番号> -->\` を同じコメントに書く。**新しいコミットもPRも作らない**`,
        ]
      : []),
    `   - 設定・Secrets・外部サービスの設定が原因: ${marker("config")}`,
    `   - マイグレーションの失敗（記録が残ってP3009で止まる・SQLが本番で失敗した）: ${marker("migration")} または ${marker("migration_unsafe")}（「マイグレーションの失敗の扱い」の節）`,
    `   - それ以外のDBの状態（データの不整合など）が原因: ${marker("database")}`,
    `   - 外部障害（GitHub・VPS・ネットワークの一時的な障害）: ${marker("external")}`,
    `   - 判断できない: ${marker("unknown")}`,
    "2. `code`・`migration`以外と判断した場合は、**コミットもPRも作らずに終える。** 報告コメントに、人が次にやる操作（コマンド・設定場所）を具体的に書く。データの削除や状態の分からないDBの修復は行わない",
    "3. `code`・`migration`の場合だけ修正してdevelop向けPRを作る。修正は失敗の原因に限り、ほかの変更を混ぜない",
    ...(migration ? [] : migrationGuideLines),
    "",
    params.throughMain
      ? "開始者がmainへの反映まで許可しています。developへマージされると、issue-deckが復旧PRを作り、CIが通れば自動でmainへ反映し、稼働中の版が一致するまで確かめます。この反映はあなたが行わないでください。"
      : "本番（main）への反映は、この段階では自動で行いません。developへのマージ後に人が判断します。",
    ...(params.logExcerpt ? ["", "### 失敗したジョブのログ末尾", "", "````", params.logExcerpt.replace(/`{4,}/g, "```"), "````"] : []),
    "",
    params.seriesMarker,
  ].join("\n");
}
