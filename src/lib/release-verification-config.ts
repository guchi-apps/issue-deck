/**
 * リポジトリごとの、リリース検証（#4212）の導入台帳（#4365）。
 *
 * **宣言（検証コマンド・前提・対象外理由）はここ（コード）が正で、導入状態は宣言と既存の
 * `ReleaseVerification`・`DispatchHost`から導出する**（`release-rollout.ts`）。状態の保存先は増やさない。
 *
 * **`enforced`を立てるまで、マージAPIは従来どおり検証結果を見ない。** 検証を実行する経路
 * （統合検証・全体レビュー）が配布されていないリポジトリで強制すると、結果が永遠に「未実施」の
 * ままマージできなくなる。未配布を導入済みと扱わないため、配布と運用検証が済んだものだけ`true`にする。
 * `setupGaps`・Mac検証の前提不足があるリポジトリは`true`にできない（`release-verification-config.test.ts`が守る）。
 */
export type ReleaseVerificationRepoConfig = {
  /** 検証と全体レビューを通常マージの必須条件にするか */
  enforced: boolean;
  /**
   * 統合検証を**真に不要**とする根拠。あれば`integration`は`not_applicable`で記録する。
   * 設定が足りないだけの理由をここへ書かない（それは`setupGaps`。対象外はゲートを通過してしまう）
   */
  integrationNotApplicableReason?: string;
  /**
   * 統合検証で順に実行するコマンド（#4237）。**統合したチェックアウトのルートで`bash -c`に渡す。**
   * 各コマンドは単独の`bash -c`で動くので、ディレクトリ移動や仮想環境は1つの文字列の中で完結させる。
   * **他リポジトリへ`pnpm`前提のコマンドを流用して誤った成功を出さない**（実際のCIに合わせる）
   */
  integrationCommands?: readonly string[];
  /** `ios/`配下の差分があるときにMacでのビルド確認（`ios/scripts/remote-build-check.sh`）を行うか */
  macBuildCheck?: boolean;
  /** `ios/scripts/remote-build-check.sh`を対象リポジトリへ配布済みか。`macBuildCheck`のとき`true`が要る */
  macScriptDistributed?: boolean;
  /** 技術構成の短い説明（一覧の表示用） */
  stack?: string;
  /**
   * 検証コマンドを完走させるのに足りない前提（DB・環境変数・配布物など）。
   * **1件でもあれば設定不足**として扱い、統合検証は`failed`（理由付き）で記録して成功にしない
   */
  setupGaps?: readonly string[];
};

/** 本番リリースが無い・アーカイブ済みなどで、検証の対象にしないリポジトリと根拠 */
export const RELEASE_VERIFICATION_EXCLUSIONS: Readonly<Record<string, string>> = {
  "guchi-apps/aide-ios": "アーカイブ済み（運用終了）",
  "guchi-apps/subscription-lists": "アーカイブ済み（運用終了）",
  "guchi-apps/trainroute": "アーカイブ済み（運用終了）",
  "guchi-apps/shopping-list": "アーカイブ済み（運用終了）",
  "guchi-apps/docs": "共有知識リポジトリ。main直接運用でdevelop→mainの本番リリースが無い",
  "guchi-apps/question": "メモ用リポジトリ。ビルド・本番リリースが無い",
  "guchi-apps/ideas": "メモ用リポジトリ。ビルド・本番リリースが無い",
  "guchi-apps/claude-config": "設定配布用リポジトリ。develop→mainの本番リリース経路が無い",
  "guchi-apps/vps": "インフラ設定リポジトリ。mainへのマージで`deploy.yml`が実機へ反映する方式で、リリースPRを持たない（配布方式が異なるため別Issueで扱う）",
  "guchi-apps/subpc": "インフラ設定リポジトリ。mainへのマージで`deploy.yml`が実機へ反映する方式で、リリースPRを持たない（配布方式が異なるため別Issueで扱う）",
  "guchi-apps/pi0w_260719": "ハードウェア用リポジトリ。GitHub Actionsのリリース経路が無い",
  "guchi-apps/gucchii-os": "リリースワークフローが無い（本番リリース経路が無い）",
  "guchi-apps/uptime-kuma": "外部ソフトの設定置き場。本番リリース経路が無い",
  "guchi-apps/sensor_260531": "ハードウェア用リポジトリ。リリース経路が無い",
  "guchi-apps/sensor_260218": "ハードウェア用リポジトリ。リリース経路が無い",
  "guchi-apps/wifi-speed": "個人用スクリプト。リリース経路が無い",
};

const NPM_CI = "npm ci";
const PYTHON_VENV = "python3 -m venv .venv && . .venv/bin/activate && python -m pip install --upgrade pip";

export const RELEASE_VERIFICATION_REPOS: Readonly<Record<string, ReleaseVerificationRepoConfig>> = {
  // 検証ジョブ・全体レビュー・画面は揃っている。運用検証（実リリース候補での実走）が済むまで強制しない
  "guchi-apps/issue-deck": {
    enforced: false,
    stack: "Next.js（pnpm）＋iOS",
    integrationCommands: ["pnpm install --frozen-lockfile", "pnpm test", "pnpm run build:ci"],
    macBuildCheck: true,
    macScriptDistributed: true,
  },
  "guchi-apps/aide": {
    enforced: false,
    stack: "Node（npm）＋iOS",
    integrationCommands: [
      NPM_CI,
      "npm run typecheck",
      "npm test",
      "node ios/scripts/check-consistency.mjs",
      "node --test ios/scripts/*.test.mjs",
    ],
    macBuildCheck: true,
    macScriptDistributed: true,
  },
  "guchi-apps/kurashio": {
    enforced: false,
    stack: "Python（pytest）＋frontend（npm）＋iOS",
    integrationCommands: [
      `${PYTHON_VENV} && pip install -r requirements-dev.txt && pytest tests/ -q`,
      "cd frontend && npm ci && npm run typecheck && npm run test",
      "node ios/scripts/check-consistency.mjs",
      "node --test ios/scripts/*.test.mjs",
    ],
    macBuildCheck: true,
    macScriptDistributed: true,
  },
  "guchi-apps/asset-manager": {
    enforced: false,
    stack: "Node（npm）＋Prisma",
    integrationCommands: [NPM_CI, "npm run lint", "npm test", "npm run verify:build"],
  },
  "guchi-apps/yoteiflow": {
    enforced: false,
    stack: "Next.js（pnpm）＋iOS",
    integrationCommands: [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test:unit",
      "node --test ios/scripts/*.test.mjs",
      "pnpm build:ci",
    ],
    macBuildCheck: true,
    macScriptDistributed: true,
  },
  "guchi-apps/morrow": {
    enforced: false,
    stack: "Next.js（pnpm）＋iOS",
    integrationCommands: [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test:unit",
      "pnpm build:ci",
    ],
    macBuildCheck: true,
    macScriptDistributed: true,
  },
  "guchi-apps/status-hub": {
    enforced: false,
    stack: "Node（npm）",
    integrationCommands: [NPM_CI, "npm run lint", "npx tsc --noEmit", "npm test", "npm run build"],
  },
  "guchi-apps/signaly": {
    enforced: false,
    stack: "Python（unittest）",
    integrationCommands: [
      `${PYTHON_VENV} && pip install -r backend/requirements.txt && python -m unittest discover -s backend -p 'test_*.py' -v`,
    ],
  },
  "guchi-apps/work-relay": {
    enforced: false,
    stack: "Next.js（pnpm）",
    integrationCommands: [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build:ci",
    ],
  },
  "guchi-apps/clip-hive": {
    enforced: false,
    stack: "Node（npm）",
    integrationCommands: [NPM_CI, "npm run lint", "npm run typecheck", "npm run build:ci"],
  },
  "guchi-apps/db-console": {
    enforced: false,
    stack: "Node（npm）＋Prisma",
    integrationCommands: [NPM_CI, "npm run lint", "npx tsc --noEmit", "npm test", "bash scripts/verify-build.sh"],
  },
  "guchi-apps/stockly": {
    enforced: false,
    stack: "Next.js（pnpm）＋Prisma",
    integrationCommands: [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test:unit",
      "pnpm build:ci",
      "bash scripts/check-dev-login-disabled.sh",
    ],
  },
  "guchi-apps/meisai-lab": {
    enforced: false,
    stack: "Node（npm）",
    integrationCommands: [NPM_CI, "npm run lint", "npm run typecheck", "npm run build:ci"],
  },
  "guchi-apps/car-care": {
    enforced: false,
    stack: "Node（npm）",
    integrationCommands: [NPM_CI, "npm run lint", "npm run build:ci"],
  },
  "guchi-apps/solitaire": {
    enforced: false,
    stack: "Node（npm・lockfileなし）",
    integrationCommands: ["npm test", "npm run build"],
  },
  "guchi-apps/portfolio": {
    enforced: false,
    stack: "Node（npm）",
    integrationCommands: [NPM_CI, "npm run lint", "npm run build"],
  },
};

/**
 * Mac検証の前提不足（`ios/scripts/remote-build-check.sh`が未配布）。Linuxの統合検証は止めないが、
 * 導入状態は設定不足になり、`enforced`にもできない（実行時は未確認範囲つきの要確認になる）
 */
export function describeMacSetupGap(repoFullName: string): string | null {
  const config = RELEASE_VERIFICATION_REPOS[repoFullName];
  if (!config?.macBuildCheck || config.macScriptDistributed === true) return null;
  return "Mac検証の`ios/scripts/remote-build-check.sh`が未配布";
}

/** 台帳にも対象外にも載っていない（導入漏れ）。設定が無いだけで検証済みや対象外にしない */
export function isRegisteredForReleaseVerification(repoFullName: string): boolean {
  return repoFullName in RELEASE_VERIFICATION_REPOS || repoFullName in RELEASE_VERIFICATION_EXCLUSIONS;
}

export function getReleaseVerificationConfig(repoFullName: string): ReleaseVerificationRepoConfig {
  return RELEASE_VERIFICATION_REPOS[repoFullName] ?? { enforced: false };
}

/** 統合検証を**真に不要**とする根拠。無ければ`null`（根拠のない対象外を作らない） */
export function describeIntegrationNotApplicable(repoFullName: string): string | null {
  const exclusion = RELEASE_VERIFICATION_EXCLUSIONS[repoFullName];
  if (exclusion) return exclusion;
  return getReleaseVerificationConfig(repoFullName).integrationNotApplicableReason ?? null;
}

/**
 * 統合検証を実行できない**設定不足**の理由。実行できるなら`null`。
 * `not_applicable`にせず失敗として記録し、ゲートを通過させない（#4365）
 */
export function describeIntegrationSetupGap(repoFullName: string): string | null {
  if (describeIntegrationNotApplicable(repoFullName) !== null) return null;
  const config = RELEASE_VERIFICATION_REPOS[repoFullName];
  if (!config) return "このリポジトリはリリース検証の導入台帳に登録されていません（未導入）";
  if (!config.integrationCommands || config.integrationCommands.length === 0) {
    return "このリポジトリには統合検証のコマンドが設定されていません";
  }
  if (config.setupGaps && config.setupGaps.length > 0) {
    return `検証の前提が未整備です: ${config.setupGaps.join("／")}`;
  }
  return null;
}
