/**
 * リポジトリごとの、リリース検証（#4212）の強制設定。
 *
 * **`enforced`を立てるまで、マージAPIは従来どおり検証結果を見ない。** 検証を実行する経路
 * （統合検証・全体レビュー）が配布されていないリポジトリで強制すると、結果が永遠に「未実施」の
 * ままマージできなくなる。未配布を導入済みと扱わないため、配布と運用検証が済んだものだけ`true`にする。
 */
export type ReleaseVerificationRepoConfig = {
  /** 検証と全体レビューを通常マージの必須条件にするか */
  enforced: boolean;
  /** 統合検証を対象外にする理由（ビルド対象が無い等）。あれば`integration`は`not_applicable`で記録する */
  integrationNotApplicableReason?: string;
};

export const RELEASE_VERIFICATION_REPOS: Readonly<Record<string, ReleaseVerificationRepoConfig>> = {
  // 検証ジョブ（PR2）・全体レビューと画面（PR3）が揃うまで強制しない
  "guchi-apps/issue-deck": { enforced: false },
};

export function getReleaseVerificationConfig(repoFullName: string): ReleaseVerificationRepoConfig {
  return RELEASE_VERIFICATION_REPOS[repoFullName] ?? { enforced: false };
}
