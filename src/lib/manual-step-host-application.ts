import { db } from "@/lib/db";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { extractVerificationCommands } from "@/lib/manual-step-command";
import { parseManualStepGuide, type ManualStepGuide } from "@/lib/manual-step-guide";

/**
 * ローカルの**全ホストで揃える**手作業（`（ローカル・全ホスト）`）の、ホストごとの適用状況（#5568）。
 *
 * 各ホストのローカルの状態を変える手順（`.env`・launchd／systemd・ツール導入など）は、
 * サブPCとMac miniの片方だけに入れると、担当が切り替わったときにもう片方で失敗する。
 * そこで「全ホストで完了の確認が通るまで完了にしない」を、**ホストごとの確認結果**で表す。
 *
 * **新しい記録は持たない。** 適用済みかどうかは、成功した確認コマンドの代行実行ジョブ
 * （`DispatchJob.kind=MANUAL_STEP`・`SUCCEEDED`・終了コード0）の`targetHost`から導く。
 * ホストごとに別の表を持つと、ジョブの履歴と二重になり、どちらが正か分からなくなる。
 *
 * 対象のホストは、代行実行を申告したことのあるローカルのホストすべて（オフラインも含む）。
 * オフラインのホストは「未適用」のまま残り、戻ったときの実行対象になる
 * （一時的な停止で作業全体を止めない。ただし全ホストが揃うまでは完了にもしない）。
 */

/** 1ホストぶんの適用状況 */
export type ManualStepHostApplication = {
  /** `DispatchHost.name`（識別子）。画面へ出すときは`formatDispatchHostName`を通す */
  host: string;
  /** そのホストで、確認コマンドがすべて成功しているか */
  applied: boolean;
};

/** 本文が「ローカルの全ホストで揃える手作業」か。手順の文頭か「実行するデバイス」の印で決まる */
export function isManualStepAllHostsGuide(guide: ManualStepGuide): boolean {
  return guide.where.allHosts || guide.steps.some((step) => step.allHosts);
}

/**
 * ホストごとの適用状況を求める。
 *
 * **確認コマンドが無ければ、どのホストも未適用**（確かめようが無いものを済みとして出さない）。
 * 照合はコマンドの文字列で行う（行番号は本文の編集でずれる。`recordManualStepVerificationPass`と同じ）。
 */
export function computeManualStepHostApplications(params: {
  commands: readonly string[];
  succeededJobs: readonly { command: string | null; targetHost: string }[];
  hosts: readonly string[];
}): ManualStepHostApplication[] {
  const succeeded = new Map<string, Set<string>>();
  for (const job of params.succeededJobs) {
    if (job.command === null) continue;
    const set = succeeded.get(job.targetHost) ?? new Set<string>();
    set.add(job.command);
    succeeded.set(job.targetHost, set);
  }

  return [...new Set(params.hosts)]
    .sort((a, b) => a.localeCompare(b))
    .map((host) => {
      const done = succeeded.get(host);
      const applied =
        params.commands.length > 0 &&
        done !== undefined &&
        params.commands.every((command) => done.has(command));
      return { host, applied };
    });
}

/** 全ホストで適用済みか。ホストが1台も分からないときは`false`（済みとは言えない） */
export function isManualStepAppliedOnAllHosts(
  applications: readonly ManualStepHostApplication[],
): boolean {
  return applications.length > 0 && applications.every((entry) => entry.applied);
}

/** 画面に出す1行（例: `Mac mini 済／サブPC 未適用`） */
export function describeManualStepHostApplications(
  applications: readonly ManualStepHostApplication[],
): string {
  return applications
    .map((entry) => `${formatDispatchHostName(entry.host)} ${entry.applied ? "済" : "未適用"}`)
    .join("／");
}

/** 未適用のホストのうち、先に実行する対象（優先順に並んだ`candidates`の先頭）を選ぶ */
export function pickPendingManualStepHost(
  applications: readonly ManualStepHostApplication[],
  candidates: readonly string[],
): string | null {
  const pending = new Set(applications.filter((entry) => !entry.applied).map((e) => e.host));
  return candidates.find((name) => pending.has(name)) ?? null;
}

/** 成功ジョブの照会で見る件数の上限（同じ確認を何度流しても最新だけ効くため、多く持たない） */
const SUCCEEDED_JOB_LOOKBACK = 500;

/**
 * 全ホストで揃える手作業Issueの適用状況を、まとめて引く（一覧・詳細の表示用）。
 *
 * 対象でないIssue（全ホストの印が無い・確認コマンドが無い）は結果に含めない。**N+1にしない**ため、
 * ホストの申告・成功ジョブはそれぞれ1本で引く。
 *
 * @returns キーは`owner/repo#番号`（`buildDispatchActiveKey`と同じ形）
 */
export async function listManualStepHostApplications(
  issues: readonly { repositoryFullName: string; number: number; body: string | null }[],
): Promise<Map<string, ManualStepHostApplication[]>> {
  const targets = issues.flatMap((issue) => {
    if (!issue.body) return [];
    const guide = parseManualStepGuide(issue.body);
    if (!isManualStepAllHostsGuide(guide)) return [];
    const commands = extractVerificationCommands(issue.body).map((entry) => entry.command);
    return commands.length === 0 ? [] : [{ ...issue, commands }];
  });
  const result = new Map<string, ManualStepHostApplication[]>();
  if (targets.length === 0) return result;

  const [hosts, jobs] = await Promise.all([
    db.dispatchHost.findMany({ where: { manualStepCapable: true }, select: { name: true } }),
    db.dispatchJob.findMany({
      where: {
        kind: "MANUAL_STEP",
        status: "SUCCEEDED",
        exitCode: 0,
        OR: targets.map((target) => ({
          repositoryFullName: target.repositoryFullName,
          issueNumber: target.number,
        })),
      },
      select: { repositoryFullName: true, issueNumber: true, command: true, targetHost: true },
      orderBy: { finishedAt: "desc" },
      take: SUCCEEDED_JOB_LOOKBACK,
    }),
  ]);
  const hostNames = hosts.map((host) => host.name);

  for (const target of targets) {
    result.set(
      `${target.repositoryFullName}#${target.number}`,
      computeManualStepHostApplications({
        commands: target.commands,
        hosts: hostNames,
        succeededJobs: jobs.filter(
          (job) =>
            job.repositoryFullName === target.repositoryFullName &&
            job.issueNumber === target.number,
        ),
      }),
    );
  }
  return result;
}
