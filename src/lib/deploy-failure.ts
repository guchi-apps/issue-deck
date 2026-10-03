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
