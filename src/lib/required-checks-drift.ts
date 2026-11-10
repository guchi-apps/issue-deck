/**
 * 必須チェックの「ルールセット」と「classicブランチ保護」のずれ、および発行元のない必須チェックの
 * 検知（#5313。#5298の再発防止）。
 *
 * #5257はルールセットだけを直し、classic側に廃止済みの`issue-deck/ci-gate`が残ったまま
 * develop向けPRが全件`blocked`になった。必須チェックは2か所に置けて両方が効くので、
 * 片方にしか無い項目と、どのワークフロー・コードも発行しない項目を、詰まる前に見つける。
 *
 * この関数群は純関数だけ。取得・通知は`required-checks-drift-run.ts`が持つ。
 * **検知と通知までで、自動修正はしない**（classic保護の更新は人が行う）。
 */

import { IOS_PRECHECK_CONTEXT } from "@/lib/github/ios-precheck";

/** issue-deckのコードがcommit statusとして発行している文脈（ワークフローのジョブ名では見つからない） */
export const CODE_PUBLISHED_CONTEXTS: readonly string[] = [IOS_PRECHECK_CONTEXT];

export const REQUIRED_CHECKS_DRIFT_MARKER = "<!-- issue-deck:required-checks-drift -->";

export type RequiredCheckSources = {
  /** ルールセット（`/rules/branches/{branch}`）の必須チェック名 */
  ruleset: string[];
  /** classic保護の必須チェック名 */
  classic: string[];
};

export type RequiredCheckFinding =
  | { kind: "only_in_ruleset"; name: string }
  | { kind: "only_in_classic"; name: string }
  | { kind: "no_publisher"; name: string; where: ("ruleset" | "classic")[] };

/** ワークフローYAMLから、ジョブID・ジョブの`name:`を発行元の候補として拾う（`jobs:`直下のみ） */
export function workflowJobNames(yaml: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  for (const line of yaml.replace(/\r/g, "").split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      inJobs = false;
      continue;
    }
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      names.push(id[1]);
      continue;
    }
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    // 式（`${{ }}`）を含む名前は静的に決まらないので候補にしない
    if (name && !name[1].includes("${{")) names.push(name[1].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return names;
}

/** 発行元として認める名前の集合を作る */
export function buildPublisherSet(input: {
  manifestGroups: string[];
  workflowYamls: string[];
  extra?: readonly string[];
}): Set<string> {
  const set = new Set<string>([...input.manifestGroups, ...(input.extra ?? CODE_PUBLISHED_CONTEXTS)]);
  for (const yaml of input.workflowYamls) {
    for (const name of workflowJobNames(yaml)) set.add(name);
  }
  return set;
}

export function detectRequiredCheckDrift(
  sources: RequiredCheckSources,
  publishers: Set<string>,
): RequiredCheckFinding[] {
  const ruleset = new Set(sources.ruleset);
  const classic = new Set(sources.classic);
  const findings: RequiredCheckFinding[] = [];
  const all = [...new Set([...ruleset, ...classic])].sort();
  for (const name of all) {
    const inRuleset = ruleset.has(name);
    const inClassic = classic.has(name);
    if (!publishers.has(name)) {
      findings.push({
        kind: "no_publisher",
        name,
        where: [...(inRuleset ? (["ruleset"] as const) : []), ...(inClassic ? (["classic"] as const) : [])],
      });
      continue;
    }
    if (inRuleset && !inClassic) findings.push({ kind: "only_in_ruleset", name });
    if (inClassic && !inRuleset) findings.push({ kind: "only_in_classic", name });
  }
  return findings;
}

const KIND_LABEL: Record<RequiredCheckFinding["kind"], string> = {
  no_publisher: "発行元がない（必須のままだとPRが永久に待機する）",
  only_in_ruleset: "ルールセットにだけある（classic保護に無い）",
  only_in_classic: "classic保護にだけある（ルールセットに無い）",
};

export function findingsSignature(branch: string, findings: RequiredCheckFinding[]): string {
  return `${branch}:${findings.map((f) => `${f.kind}=${f.name}`).join(",")}`;
}

export function buildDriftIssueTitle(repositoryFullName: string): string {
  return `[要確認] ${repositoryFullName}の必須チェックにずれ・発行元のない項目があります`;
}

export function buildDriftIssueBody(input: {
  repositoryFullName: string;
  byBranch: { branch: string; findings: RequiredCheckFinding[] }[];
  signature: string;
}): string {
  const lines: string[] = [
    `issue-deckの定期巡回が、\`${input.repositoryFullName}\`の必須チェックでずれを検知しました（#5313）。`,
    "ルールセットとclassicブランチ保護の両方に必須チェックを置けて、両方が効きます。どちらかにだけ残った項目や、`ci/required-checks.json`・ワークフロー・コードのどれも発行しない項目があると、PRが`blocked`のまま進みません（#5298）。",
    "",
  ];
  for (const { branch, findings } of input.byBranch) {
    lines.push(`### \`${branch}\``, "");
    for (const f of findings) {
      const where = f.kind === "no_publisher" ? `（${f.where.join("・")}）` : "";
      lines.push(`- \`${f.name}\` — ${KIND_LABEL[f.kind]}${where}`);
    }
    lines.push("");
  }
  lines.push(
    "### 確認の方法",
    "",
    "```bash",
    "cd /home/guchi/apps/issue-deck && gh api repos/guchi-apps/issue-deck/rules/branches/develop --jq '[.[]|select(.type==\"required_status_checks\")|.parameters.required_status_checks[].context]'",
    "cd /home/guchi/apps/issue-deck && gh api repos/guchi-apps/issue-deck/branches/develop --jq '.protection.required_status_checks.contexts'",
    "```",
    "",
    "自動では直しません。不要な項目は人が外してください（classic保護の更新は`docs/multi-agent/auto-repair.md`の手順を参照）。ずれが解消されると、次の巡回でこのIssueは自動でクローズされます。",
    "",
    REQUIRED_CHECKS_DRIFT_MARKER,
    `<!-- required-checks-drift-signature: ${input.signature} -->`,
  );
  return lines.join("\n");
}

/** 既存Issue本文から、前回起票時のずれの署名を取り出す */
export function extractSignature(body: string | null): string | null {
  const m = /<!-- required-checks-drift-signature: (.*?) -->/.exec(body ?? "");
  return m ? m[1] : null;
}
