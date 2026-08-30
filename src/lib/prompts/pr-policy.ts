/**
 * Pull Requestを「人の指示があってから」作るリポジトリ（#2499）。
 *
 * **一覧の正は`scripts/local-repo-pr-policy.conf`**（サブPCの汎用ランチャーとセッションの
 * 回収がそれを読む）。ここはブラウザで動く「実装プロンプトをコピー」用の写しで、
 * **ブラウザからファイルは読めない**ため一覧を持たざるを得ない。ずれは
 * `templates.test.ts`が実物のconfを読んで検出する。**片方だけ直さないこと。**
 *
 * 文面も`scripts/generic-start-issue.sh`の`pr_policy_instructions`と同じものを持つ
 * （`preview_instructions`・`artifact_instructions`と同じ構造）。起動経路によって指示が
 * 変わらないよう、変えるときは両方そろえる。
 */

/** 一覧の正。テストがここを読んで写しと突き合わせる */
export const LOCAL_REPO_PR_POLICY_CONF_PATH = "scripts/local-repo-pr-policy.conf";

/** `scripts/local-repo-pr-policy.conf`の`manual`行の写し */
export const MANUAL_PR_REPOSITORIES: readonly string[] = ["guchi-apps/ideas"];

export function isManualPrRepository(repositoryFullName: string): boolean {
  return MANUAL_PR_REPOSITORIES.includes(repositoryFullName);
}

/**
 * confの`manual`行を読み出す（テスト用）。シェル側（`scripts/lib/pr-policy.sh`）と
 * 同じく、`<owner>/<repo><空白><ポリシー>`だけに一致させ、行末コメントは受け付けない。
 */
export function parseManualPrRepositories(conf: string): string[] {
  const repositories: string[] = [];
  for (const rawLine of conf.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*(#|$)/.test(line)) continue;
    const matched = /^\s*(\S+)\s+([A-Za-z]+)\s*$/.exec(line);
    if (!matched) continue;
    if (matched[2] === "manual") repositories.push(matched[1]);
  }
  return repositories;
}

/** 「責務」へ差し込むPull Requestの作り方。`{{PR_POLICY_INSTRUCTIONS}}`の値になる */
export function prPolicyInstructions(params: {
  repositoryFullName: string;
  issueNumber: number;
  /** マージ先ブランチ。起動経路によって実ブランチ名か「セッションで用意してください」になる */
  baseBranch: string;
}): string {
  const { repositoryFullName, issueNumber, baseBranch } = params;
  if (isManualPrRepository(repositoryFullName)) {
    return [
      `- **Pull Requestは、ユーザーから指示されるまで作りません。** このリポジトリ（\`${repositoryFullName}\`）は、成果物を一度で仕上げるのではなく同じセッションで何度も練り直す使い方をします。コミットとpush（\`issue-${issueNumber}\`ブランチ）はいつでも行ってよいですが、\`gh pr create\`は「PRを作って」と言われてから実行します`,
      "- **`11.local`もPull Requestを作るまで外しません。** 外すと「ローカル作業を終えた」と判定され、数分でこのセッションが自動終了します（`scripts/reap-sessions.sh`）。PRを作らない限り畳まれないので、続きは同じ会話でやり取りできます",
      "- 一区切りついたら、Pull Requestを作る代わりに**どこまで進んだかをIssueコメントへ残し**、次に何をするかを`AskUserQuestion`でユーザーへ尋ねます（フックが`00.check-user`と`01.check-input`を付け、issue-deckのPush通知が飛びます。答えた時点で外れます）",
      `- 指示を受けてPull Requestを作るときは\`${baseBranch}\`向けに作成し（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載）、マージ時点ではissueをcloseしない運用のため\`closes #番号\`/\`fixes #番号\`は使わず\`#${issueNumber}\`のように番号のみ記載します。作成したら\`11.local\`を外します`,
    ].join("\n");
  }
  return [
    `- \`${baseBranch}\` 向けPull Requestを作成する（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載）。マージ時点ではissueをcloseしない運用のため、PR本文に\`closes #番号\`/\`fixes #番号\`は使わず、\`#${issueNumber}\`のように番号のみ記載する`,
    "- Pull Requestを作成してレビューへ渡し、ローカルでの作業を終える時点で`11.local`を外す。付けたままだと、無人実行（`claude-issue-dispatch.yml`を持つリポジトリの場合）がこのIssueへの追加対応を一切行えない。ローカルで作業を続けている間は付けたままにする",
  ].join("\n");
}
