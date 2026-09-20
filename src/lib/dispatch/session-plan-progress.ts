import { reportProgressStatus } from "@/lib/github/report-progress";

/**
 * 画面から計画を承認したとき、進捗を`Planning`から`Implementation`へ進める（#3213）。
 *
 * **ローカルセッションには、承認を受けて進捗を進める経路が無かった。** 起動時
 * （`scripts/lib/progress-report.sh`）は`21.plan-required`なら`Planning`を報告するだけで、
 * 承認後に`Implementation`へ進めるのは無人実行だけ（ワークフローのシェルステップ）。そのため
 * 承認して実装が始まっても、一覧のバーも詳細のステップも「計画」のまま次の`Develop PR`まで
 * 動かなかった。Claude Codeでもエージェント種別を問わず同じで、Codexではさらに作業ステップも
 * 出ないので「計画検討中」で固定されて見えた。
 *
 * **`onlyFrom: planning`に絞る。** すでに`Implementation`以降へ進んでいるIssue（再開・修正の
 * 差し戻しなど）を巻き戻さず、盤面に載っていない・別の段のIssueには何もしない。
 * **失敗しても投げない**（返事はもうDBに入っていてセッションへ届く。`resolveSessionPlanCheckUser`と
 * 同じ扱い）。
 *
 * **`session-plan.ts`とは別のファイルにしてある。** `report-progress`はモジュールの読み込み時に
 * GitHub Appの設定（`GITHUB_APP_ID`）を要求するため、`session-plan.ts`へ置くと、そこから純関数だけを
 * 使うテスト・呼び出し元まで巻き込んで落ちる。
 */
export async function advanceSessionPlanProgress(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<boolean> {
  try {
    const result = await reportProgressStatus({
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      status: "implementation",
      onlyFrom: ["planning"],
    });
    return result.applied;
  } catch (error) {
    console.error(
      `[dispatch] 計画の承認後に進捗を実装へ進められませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
