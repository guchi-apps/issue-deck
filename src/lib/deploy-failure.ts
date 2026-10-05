/**
 * 本番デプロイ失敗の帯から起こす「修正Issue」の下書き（#3887）。
 *
 * 自動起票のデプロイ失敗Issue（`[デプロイ失敗]`）は#3895で廃止した。ここに残すのは、人が帯の
 * 「修正Issueを作成」を押したときに開く新規作成ダイアログの下書きだけで、起票はしない。
 */

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
  causeMarkerPrefix: string;
}): string {
  const facts = [
    `- 失敗した実行: ${params.failedRunUrl}（attempt ${params.failedRunAttempt}）`,
    `- 失敗したコミット: \`${params.failedSha}\``,
    `- 直近に本番デプロイが成功したコミット: ${params.runningSha ? `\`${params.runningSha}\`` : "不明"}`,
    ...(params.failedJobs.length > 0 ? [`- 失敗したジョブ: \`${params.failedJobs.join("`, `")}\``] : []),
  ];
  const marker = (cause: string) => `\`<!-- ${params.causeMarkerPrefix}${cause} -->\``;
  return [
    "## 本番復旧の自動化（AIに修正を依頼）",
    "",
    "このIssueはデプロイ失敗の帯の「AIに修正を依頼」から作られました。issue-deckが原因の区分・修正PR・CI・レビューを追跡します。",
    "",
    ...facts,
    "",
    "### 実装セッションへの指示",
    "",
    "1. **最初に**実行ログ・失敗工程・失敗したコミットまでの変更・本番で動いている版を確かめて原因を調べ、区分を次のマーカーのどれか1つを含むIssueコメントで報告する。ログ末尾の推定だけで決めない",
    `   - コードの修正で直る: ${marker("code")}`,
    `   - 設定・Secrets・外部サービスの設定が原因: ${marker("config")}`,
    `   - DBの状態（失敗したマイグレーションの履歴など）が原因: ${marker("database")}`,
    `   - 外部障害（GitHub・VPS・ネットワークの一時的な障害）: ${marker("external")}`,
    `   - 判断できない: ${marker("unknown")}`,
    "2. `code`以外と判断した場合は、**コミットもPRも作らずに終える。** 報告コメントに、人が次にやる操作（コマンド・設定場所）を具体的に書く。データの削除や状態の分からないDBの修復は行わない",
    "3. `code`の場合だけ修正してdevelop向けPRを作る。修正は失敗の原因に限り、ほかの変更を混ぜない",
    "",
    "本番（main）への反映は、この段階では自動で行いません。developへのマージ後に人が判断します。",
    ...(params.logExcerpt ? ["", "### 失敗したジョブのログ末尾", "", "````", params.logExcerpt.replace(/`{4,}/g, "```"), "````"] : []),
    "",
    params.seriesMarker,
  ].join("\n");
}
