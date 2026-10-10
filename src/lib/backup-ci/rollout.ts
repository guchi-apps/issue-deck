/**
 * バックアップCI（#4065）を他リポジトリへ展開する（#4308）ための純関数。
 *
 * 判定の正は`gate.ts`の`evaluateActionsRun`で、**ci.ymlのジョブ名＝定義（`ci/required-checks.json`）の
 * グループ名**で必須ジョブを照合する。したがって配布先でも、定義のグループキーとci.ymlのジョブ名が
 * 一致していなければ共通チェックが成立しない。ここはその対応の検査と、対象ごとの導入状態の判定を持つ。
 */

/** 配布するファイル（配布元＝issue-deck自身の実物。写しを雛形として別に持たない） */
export const BACKUP_CI_ROLLOUT_FILES = [
  ".circleci/config.yml",
  "scripts/ci/run-required-checks.mjs",
] as const;
/** 対象ごとに生成するファイル（対象のci.ymlから作る） */
export const BACKUP_CI_DEFINITION_PATH = "ci/required-checks.json";

export type CiWorkflowJob = {
  /** ジョブID（`jobs:`直下のキー） */
  id: string;
  /** 共通チェックの照合に使う名前。`name:`が無ければジョブID（GitHubの表示と同じ） */
  name: string;
  runsOn: string | null;
};

/**
 * ci.ymlの`jobs:`直下のジョブを取り出す。YAMLパーサーを足さずに済むよう、インデントで読む軽量版。
 * 読めない形（`jobs:`が無い）はnullにして、呼び出し側が「確認不能」として扱う（成功にしない）。
 */
export function extractCiWorkflowJobs(yamlText: string): CiWorkflowJob[] | null {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  const jobs: CiWorkflowJob[] = [];
  let current: CiWorkflowJob | null = null;
  let jobIndent = -1;
  for (const raw of lines.slice(start + 1)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break; // jobs: の外へ出た
    if (jobIndent === -1) jobIndent = indent;
    const text = raw.trim();
    if (indent === jobIndent) {
      const id = /^["']?([A-Za-z0-9_-]+)["']?:\s*(#.*)?$/.exec(text)?.[1];
      if (!id) continue;
      current = { id, name: id, runsOn: null };
      jobs.push(current);
    } else if (current && indent === jobIndent + 2) {
      const name = /^name:\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(text)?.[1];
      if (name && !name.includes("${{")) current.name = name;
      const runsOn = /^runs-on:\s*(.+?)\s*(#.*)?$/.exec(text)?.[1];
      if (runsOn) current.runsOn = runsOn.replace(/["']/g, "");
    }
  }
  return jobs.length > 0 ? jobs : null;
}

export type JobClassification = "required" | "notification" | "unsupported";

/** 通知だけのジョブは定義に入れない（issue-deckの`workflow-drift-notice`・`notify`と同じ扱い） */
const NOTIFICATION_JOB = /(^|[-_])(notify|notice|notification)([-_]|$)/i;
/** Linux（CircleCI）では代替できない検証（Mac/iOS・実機・署名）。必須判定は既存経路に残す */
const UNSUPPORTED_RUNNER = /^(macos|windows)/i;
const UNSUPPORTED_JOB = /(^|[-_])(ios|macos|testflight|xcode|android|e2e)([-_]|$)/i;

export function classifyCiJob(job: CiWorkflowJob): JobClassification {
  if (NOTIFICATION_JOB.test(job.id) || NOTIFICATION_JOB.test(job.name)) return "notification";
  if ((job.runsOn && UNSUPPORTED_RUNNER.test(job.runsOn)) || UNSUPPORTED_JOB.test(job.id)) return "unsupported";
  return "required";
}

export type DefinitionCorrespondence = {
  /** 定義のグループにあるが、ci.ymlに同名のジョブが無い（共通チェックが必ず`error`になる） */
  groupsWithoutJob: string[];
  /** ci.ymlの必須ジョブなのに、定義のグループに無い（バックアップCIで検査されない＝欠落） */
  jobsWithoutGroup: string[];
  /** Linuxで代替できないため、定義に入れず既存経路の必須判定へ残すジョブ */
  unsupportedJobs: string[];
};

/** ci.ymlのジョブと定義のグループの対応を調べる。`ok`は欠落・ずれが無いときだけ真 */
export function compareCiJobsToDefinition(
  jobs: readonly CiWorkflowJob[],
  definitionGroups: readonly string[],
  /** 定義の`excludedJobs`（意図して入れなかったジョブ。既存経路の必須判定に残す） */
  excludedJobs: readonly string[] = [],
): DefinitionCorrespondence & { ok: boolean } {
  const jobNames = new Set(jobs.map((job) => job.name));
  const groupsWithoutJob = definitionGroups.filter((group) => !jobNames.has(group));
  const required = jobs.filter((job) => classifyCiJob(job) === "required" && !excludedJobs.includes(job.name));
  const jobsWithoutGroup = required.filter((job) => !definitionGroups.includes(job.name)).map((job) => job.name);
  const unsupportedJobs = jobs
    .filter((job) => classifyCiJob(job) === "unsupported" || excludedJobs.includes(job.name))
    .map((job) => job.name);
  return { groupsWithoutJob, jobsWithoutGroup, unsupportedJobs, ok: groupsWithoutJob.length === 0 && jobsWithoutGroup.length === 0 };
}

/** 定義ファイル（JSON）のグループ名。形が崩れていればnull */
export function definitionGroupNames(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { schemaVersion, groups } = parsed as { schemaVersion?: unknown; groups?: unknown };
    if (schemaVersion !== 1 || !groups || typeof groups !== "object") return null;
    return Object.keys(groups as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** 定義の`excludedJobs`（配布時に意図して入れなかったジョブ名）。無い・形が違えば空 */
export function definitionExcludedJobs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { excludedJobs?: unknown };
    return Array.isArray(parsed.excludedJobs) ? parsed.excludedJobs.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 導入状態

export const ROLLOUT_STATUSES = ["not_installed", "needs_setup", "awaiting_verification", "ready", "update_required", "unsupported"] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

export const ROLLOUT_STATUS_LABELS: Record<RolloutStatus, string> = {
  not_installed: "未導入",
  needs_setup: "設定不足",
  awaiting_verification: "検証待ち",
  ready: "利用可能",
  update_required: "更新必要",
  unsupported: "対象外",
};

export type RolloutInput = {
  /** 配布物の有無と、配布元との内容一致（`null`は対象に無い） */
  files: Record<string, { matchesSource: boolean } | null>;
  /** 対象のci.ymlのジョブ（読めなければnull） */
  ciJobs: CiWorkflowJob[] | null;
  /** 対象の定義ファイルの生テキスト（無ければnull） */
  definitionRaw: string | null;
  /** 対象の定義が、ci.ymlから生成し直した内容と一致するか（生成不能ならnull） */
  definitionMatchesGenerated: boolean | null;
  packageManager: "pnpm" | "other" | "unknown";
  setting: { enabled: boolean; circleciProjectSlug: string | null; circleciDefinitionId: string | null; mirrorActionsToCiGate: boolean } | null;
  tokenConfigured: boolean;
  /** バックアップCIが合格した実行がある */
  hasPassedRun: boolean;
  /** 共通チェックを発行できた実績（`CiGateState.publishedState`が`publish_failed:`以外） */
  hasPublishedGate: boolean;
};

export type RolloutAssessment = {
  status: RolloutStatus;
  /** 不足項目 */
  missing: string[];
  /** 次にやること（先頭が最優先。AIが行うものと人の作業を区別して書く） */
  nextSteps: string[];
  correspondence: (DefinitionCorrespondence & { ok: boolean }) | null;
};

export function assessRollout(input: RolloutInput): RolloutAssessment {
  const missing: string[] = [];
  const nextSteps: string[] = [];
  const installedPaths = [...BACKUP_CI_ROLLOUT_FILES, BACKUP_CI_DEFINITION_PATH];
  const absent = installedPaths.filter((path) => path !== BACKUP_CI_DEFINITION_PATH && !input.files[path]);
  if (input.definitionRaw === null) absent.push(BACKUP_CI_DEFINITION_PATH);

  if (input.packageManager === "other") {
    return {
      status: "unsupported",
      missing: ["Node.js/pnpm以外のリポジトリです（配布するconfigはpnpmを前提にしています）"],
      nextSteps: ["このリポジトリは対象外です。必要になったら実行環境ごとのconfigを別Issueで追加します"],
      correspondence: null,
    };
  }
  const groups = input.definitionRaw === null ? null : definitionGroupNames(input.definitionRaw);
  const correspondence =
    input.ciJobs && groups ? compareCiJobsToDefinition(input.ciJobs, groups, definitionExcludedJobs(input.definitionRaw!)) : null;

  if (absent.length === installedPaths.length) {
    nextSteps.push("「導入PRを作る」で配布PRを作成し、対象リポジトリでマージする（AIが作成。マージは人）");
    return { status: "not_installed", missing: ["配布物が1つも入っていません"], nextSteps, correspondence };
  }
  if (absent.length > 0) missing.push(`配布物が不足: ${absent.join("、")}`);
  if (input.definitionRaw !== null && !groups) missing.push(`${BACKUP_CI_DEFINITION_PATH}の形式が不正です`);
  if (!input.ciJobs) missing.push(".github/workflows/ci.ymlのジョブを読み取れません（共通チェックの照合ができません）");
  if (correspondence) {
    if (correspondence.groupsWithoutJob.length > 0) {
      missing.push(`定義のグループにci.ymlの同名ジョブが無い: ${correspondence.groupsWithoutJob.join("、")}`);
    }
    if (correspondence.jobsWithoutGroup.length > 0) {
      missing.push(`ci.ymlの必須ジョブが定義に無い（バックアップCIで検査されません）: ${correspondence.jobsWithoutGroup.join("、")}`);
    }
  }
  if (missing.length > 0) {
    nextSteps.push("配布PRを作り直してci.ymlと定義を揃える（AIが作成。既存ファイルは差分をPR本文に出し、上書きは人が確認）");
    return { status: "needs_setup", missing, nextSteps, correspondence };
  }

  const outdated: string[] = [...BACKUP_CI_ROLLOUT_FILES].filter((path) => input.files[path] && !input.files[path]!.matchesSource);
  if (input.definitionMatchesGenerated === false) outdated.push(BACKUP_CI_DEFINITION_PATH);
  if (outdated.length > 0) {
    return {
      status: "update_required",
      missing: [`配布元と内容が違います: ${outdated.join("、")}`],
      nextSteps: ["「導入PRを作る」で更新PRを作成し、差分を確認してマージする"],
      correspondence,
    };
  }

  const setting = input.setting;
  if (!setting?.circleciProjectSlug || !setting.circleciDefinitionId) {
    missing.push("CircleCIのプロジェクトスラッグ・パイプライン定義IDが未設定です");
    nextSteps.push("（人）CircleCIでこのリポジトリをGitHub App連携でSet Upし（トリガーは作らない）、対象リポジトリのdevelop向けPR詳細「バックアップCI」欄の「このリポジトリのバックアップCI設定」にスラッグと定義IDを保存する");
  }
  if (!input.tokenConfigured) {
    missing.push("サーバーにCIRCLECI_API_TOKENがありません（全リポジトリ共通。issue-deck側で設定済みなら不要）");
  }
  if (setting && !setting.mirrorActionsToCiGate) {
    missing.push("通常Actionsの結果を共通チェックへ写す設定がオフです（必須チェック移行の前提）");
  }
  if (missing.length > 0) return { status: "needs_setup", missing, nextSteps, correspondence };

  if (!setting?.enabled || !input.hasPassedRun || !input.hasPublishedGate) {
    if (!setting?.enabled) missing.push("バックアップCIが有効になっていません");
    if (!input.hasPassedRun) missing.push("バックアップCIが合格した実行がありません（試験PRで実起動して確認してください）");
    if (input.hasPassedRun && !input.hasPublishedGate) missing.push("共通チェックの発行を確認できていません（Commit statuses: Read and write の承認を確認）");
    nextSteps.push("（人）develop向けの試験PRでPR詳細の「バックアップCIで実行」を押し、合格と共通チェックの発行を確認する");
    return { status: "awaiting_verification", missing, nextSteps, correspondence };
  }
  return { status: "ready", missing: [], nextSteps: ["必須チェックの移行は対象ごとの手順（下記）で段階的に行う"], correspondence };
}

// ---------------------------------------------------------------------------
// 必須チェックの移行・復元手順（対象ごとに生成）

/**
 * `replaceContexts`は共通チェックへ置き換える通常CIのジョブ名（定義のグループ名）。
 * **それ以外の必須チェック（レビュー・iOS検証など独立したもの）は残す。**
 * 復元は、移行の前に保存したrulesetのJSONをそのまま戻す（保存先は端末の作業ディレクトリ）。
 */
export function buildMigrationCommands(repositoryFullName: string, replaceContexts: readonly string[]) {
  const repo = repositoryFullName;
  const names = JSON.stringify(replaceContexts);
  const file = `ruleset-backup-${repo.replace("/", "-")}.json`;
  const findRuleset = `RS=$(gh api repos/${repo}/rulesets --jq '.[] | select(.target=="branch") | .id' | head -1)`;
  return {
    host: "サブPCまたはメインPC（対象リポジトリのAdministration権限を持つユーザーで`gh auth login`済みの端末）",
    /** 移行前のrulesetを保存する（復元に使う） */
    backup: `cd ~ && ${findRuleset} && gh api repos/${repo}/rulesets/$RS > ${file} && echo "saved: ${file}"`,
    migrate: `cd ~ && ${findRuleset} && gh api repos/${repo}/rulesets/$RS | jq --argjson names '${names}' '{rules: [.rules[] | if .type == "required_status_checks" then .parameters.required_status_checks |= (map(select(.context as $c | ($names | index($c)) | not)) + [{"context":"issue-deck/ci-gate","integration_id":4448617}]) else . end]}' | gh api -X PUT repos/${repo}/rulesets/$RS --input -`,
    verify: `gh api repos/${repo}/rules/branches/develop --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks'`,
    restore: `cd ~ && ${findRuleset} && jq '{rules: .rules}' ${file} | gh api -X PUT repos/${repo}/rulesets/$RS --input -`,
  };
}
