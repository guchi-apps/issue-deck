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
  /**
   * 統合検証で順に実行するコマンド（#4237）。**統合したチェックアウトのルートで`bash -c`に渡す。**
   * 無い、または空のリポジトリは検証できないので、ジョブを積まず`integration`を`not_applicable`
   * （理由付き）で記録する。**他リポジトリへ`pnpm`前提のコマンドを流用して誤った成功を出さない**
   */
  integrationCommands?: readonly string[];
  /** `ios/`配下の差分があるときにMacでのビルド確認（`ios/scripts/remote-build-check.sh`）を行うか */
  macBuildCheck?: boolean;
};

export const RELEASE_VERIFICATION_REPOS: Readonly<Record<string, ReleaseVerificationRepoConfig>> = {
  // 検証ジョブ（PR2）・全体レビューと画面（PR3）が揃うまで強制しない
  "guchi-apps/issue-deck": {
    enforced: false,
    integrationCommands: ["pnpm install --frozen-lockfile", "pnpm test", "pnpm run build:ci"],
    macBuildCheck: true,
  },
};

export function getReleaseVerificationConfig(repoFullName: string): ReleaseVerificationRepoConfig {
  return RELEASE_VERIFICATION_REPOS[repoFullName] ?? { enforced: false };
}

/** 統合検証を実行できない理由。実行できるなら`null`（`not_applicable`として記録する根拠） */
export function describeIntegrationNotApplicable(repoFullName: string): string | null {
  const config = getReleaseVerificationConfig(repoFullName);
  if (config.integrationNotApplicableReason) return config.integrationNotApplicableReason;
  if (!config.integrationCommands || config.integrationCommands.length === 0) {
    return "このリポジトリには統合検証のコマンドが設定されていません";
  }
  return null;
}
