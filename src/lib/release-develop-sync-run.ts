import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { compareBranches } from "@/lib/github/branches-api";
import {
  createBranchRef,
  createPullRequest,
  fetchBranchHeadSha,
  fetchFileTextAtRef,
  fetchMainHeadSha,
  fetchOpenPullRequestsForBase,
  fetchPullRequestCiState,
  fetchRecentClosedPullRequestsForBase,
  fetchReleaseCallerText,
} from "@/lib/github/release-api";
import {
  decideDevelopSync,
  developSyncBranchName,
  developSyncMarker,
  isDevelopSyncHeadRef,
  parseDevelopSyncMarker,
  type DevelopSyncObservation,
  type DevelopSyncPullRequest,
  type DevelopSyncStatus,
} from "@/lib/release-develop-sync";
import { parseFinalizeCallerSupport, readVersionFromText } from "@/lib/release-finalize";
import type { Context } from "@/lib/release-rc-run";

/**
 * 本番公開後のdevelop同期（#4641）の外部操作。判定は`release-develop-sync.ts`の純関数が持つ。
 *
 * - 観測は実際のGit履歴（main・developの先端と3点比較・同期PR）だけで行い、DBの記録には依存しない
 * - 同期PRはmainの先端から切った専用ブランチ（`release-sync/main-<SHA>`）をheadにする。競合したときに
 *   mainへpushせず、通常のdevelop向けPRとして解消・CI・レビュー・マージの保護を通せる
 * - 呼び出し元は公開処理（`advanceProduction`）・巡回・候補作成・画面の操作の4つで、どれも同じ判定を使う。
 *   公開処理の段階（完了・取消）に関係なく、巡回が同期済みを確かめるまで追い続ける
 */

const fullNameOf = (ctx: Context) => `${ctx.owner}/${ctx.repo}`;

/**
 * 今のmainに対して同期PRを作れなかった理由（リポジトリごと）。DBには残さず、同じmainへの再試行が
 * 成功するか、mainが進めば消える。画面と巡回が同じプロセスで読む
 */
const createFailures = new Map<string, { mainSha: string; message: string }>();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function findOpenSyncPullRequest(ctx: Context): Promise<DevelopSyncPullRequest | null> {
  const open = await fetchOpenPullRequestsForBase(ctx.owner, ctx.repo, "develop", ctx.token);
  // 専用ブランチの同期PRを優先し、無ければ#4641以前のhead=mainの同期PRを使う
  const pr = open.find((p) => p.head.ref !== "main" && isDevelopSyncHeadRef(p.head.ref)) ?? open.find((p) => p.head.ref === "main") ?? null;
  if (!pr) return null;
  const ci = await fetchPullRequestCiState(ctx.owner, ctx.repo, pr.number, ctx.token).catch(() => null);
  return {
    number: pr.number,
    url: pr.html_url,
    headRef: pr.head.ref,
    mainSha: parseDevelopSyncMarker(pr.body),
    ciState: ci?.ciState ?? "unknown",
    mergeable: ci?.mergeable ?? null,
  };
}

/** squash・rebaseでマージ済みの同期PRが、今のmainの変更を全て含むか（含むならそのPR番号） */
async function findSquashCoveredSync(ctx: Context, mainSha: string): Promise<number | null> {
  const closed = await fetchRecentClosedPullRequestsForBase(ctx.owner, ctx.repo, "develop", ctx.token);
  const merged = closed
    .filter((p) => p.merged_at !== null && isDevelopSyncHeadRef(p.head.ref) && parseDevelopSyncMarker(p.body) !== null)
    .sort((a, b) => (b.merged_at ?? "").localeCompare(a.merged_at ?? ""));
  for (const pr of merged) {
    const syncedMain = parseDevelopSyncMarker(pr.body)!;
    // 同期した時点のmainから今のmainまでに、変更ファイルが無ければ全て含む
    const since = await compareBranches(ctx.owner, ctx.repo, syncedMain, mainSha, ctx.token);
    if (since === null) throw new Error(`同期PR #${pr.number} 以降のmainの変更を取得できませんでした`);
    if (since.behindBy > 0 && since.aheadBy > 0) continue; // 別系統のmain（書き換え等）。この同期PRでは判定しない
    if (since.aheadBy === 0 || (since.files !== null && since.files.length === 0)) return pr.number;
    return null;
  }
  return null;
}

/** 実際のGit履歴から同期の状況を観測する。**取得できなかったものは同期済みと推定せず`unreadable`にする** */
export async function observeDevelopSync(ctx: Context): Promise<DevelopSyncObservation> {
  let mainSha: string | null;
  let developSha: string | null;
  try {
    [mainSha, developSha] = await Promise.all([
      fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token),
      fetchBranchHeadSha(ctx.owner, ctx.repo, "develop", ctx.token),
    ]);
  } catch (error) {
    return { kind: "unreadable", reason: `mainまたはdevelopの先端を取得できませんでした（${errorMessage(error)}）` };
  }
  if (!mainSha) return { kind: "unreadable", reason: "mainの先端を取得できませんでした" };
  if (!developSha) return { kind: "unreadable", reason: "developの先端を取得できませんでした" };

  const compare = await compareBranches(ctx.owner, ctx.repo, developSha, mainSha, ctx.token).catch(() => null);
  if (compare === null) return { kind: "unreadable", reason: "mainとdevelopの差分を取得できませんでした" };
  const mainInDevelop = compare.aheadBy === 0;
  if (!mainInDevelop && compare.files === null) return { kind: "unreadable", reason: "mainにだけある変更ファイルを取得できませんでした" };
  const mainOnlyFiles = mainInDevelop ? [] : compare.files!.map((f) => f.filename);
  const failure = createFailures.get(fullNameOf(ctx));
  const observed = {
    kind: "observed" as const,
    mainSha,
    developSha,
    mainInDevelop,
    mainOnlyFiles,
    squashCoveredBy: null,
    openPullRequest: null,
    createFailure: failure && failure.mainSha === mainSha ? failure.message : null,
  };
  if (mainInDevelop || mainOnlyFiles.length === 0) return observed;

  try {
    const squashCoveredBy = await findSquashCoveredSync(ctx, mainSha);
    if (squashCoveredBy !== null) return { ...observed, squashCoveredBy };
    return { ...observed, openPullRequest: await findOpenSyncPullRequest(ctx) };
  } catch (error) {
    return { kind: "unreadable", reason: `同期PRの状況を取得できませんでした（${errorMessage(error)}）` };
  }
}

async function readMainVersion(ctx: Context, mainSha: string): Promise<string | null> {
  const caller = parseFinalizeCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
  if (!caller.supported) return null;
  return readVersionFromText(await fetchFileTextAtRef(ctx.owner, ctx.repo, caller.versionFile, mainSha, ctx.token).catch(() => null), caller.versionQuery);
}

async function createSyncPullRequest(ctx: Context, mainSha: string, files: string[]): Promise<void> {
  const branch = developSyncBranchName(mainSha);
  await createBranchRef(ctx.owner, ctx.repo, branch, mainSha, ctx.token);
  const version = await readMainVersion(ctx, mainSha);
  const target = version ? `v${version}（main ${mainSha.slice(0, 7)}）` : `main ${mainSha.slice(0, 7)}`;
  const listed = files.slice(0, 20).map((f) => `  - \`${f}\``);
  await createPullRequest(ctx.owner, ctx.repo, ctx.token, {
    title: `${target}の公開をdevelopへ同期する`,
    base: "develop",
    head: branch,
    body: [
      `mainへ公開した内容のうち、developにまだ入っていない変更をdevelopへ取り込みます（#4641）。`,
      "",
      `- 対象: ${target}。mainにだけある変更は${files.length}ファイルです`,
      ...listed,
      ...(files.length > 20 ? [`  - ほか${files.length - 20}件`] : []),
      "- リリース候補上の修正・競合解消・正式バンプ・更新履歴・iOSの版情報を含みます。通常のマージで取り込むため、developの後続の開発は保持されます",
      "- **マージコミットでマージしてください。** 競合したら、このブランチへdevelopを取り込んで解消します（mainへは直接pushしません）",
      "- このPRがマージされ、mainの公開内容がdevelopへ戻るまで、次のリリース候補は作れません",
      "",
      developSyncMarker(mainSha),
    ].join("\n"),
  });
}

/**
 * 同期を確かめ、未同期で同期PRが無ければ作る。**例外を投げない**（呼び出し元の公開処理・巡回を止めない）。
 * 同じmainへの同期PRはブランチ名が同じなので、巡回が重なっても1本にしかならない
 */
export async function ensureDevelopSync(ctx: Context): Promise<DevelopSyncStatus> {
  const fullName = fullNameOf(ctx);
  try {
    const observation = await observeDevelopSync(ctx);
    const status = decideDevelopSync(observation);
    if (observation.kind !== "observed" || status.state !== "unsynced" || observation.openPullRequest !== null) return status;
    try {
      await createSyncPullRequest(ctx, observation.mainSha, observation.mainOnlyFiles);
      createFailures.delete(fullName);
    } catch (error) {
      console.error("[release-develop-sync] 同期PRを作成できませんでした", fullName, error);
      // 同時に別の巡回が作った（同じhead→baseの422）場合は、取り直したときに開いている同期PRとして見つかる
      createFailures.set(fullName, { mainSha: observation.mainSha, message: errorMessage(error) });
    }
    return decideDevelopSync(await observeDevelopSync(ctx));
  } catch (error) {
    console.error("[release-develop-sync] 同期を確認できませんでした", fullName, error);
    return decideDevelopSync({ kind: "unreadable", reason: `同期を確認できませんでした（${errorMessage(error)}）` });
  }
}

/** 巡回の間隔。pollerは短い間隔で呼ぶため、リポジトリごとにこれより短くは確かめない */
const SWEEP_INTERVAL_MS = 5 * 60_000;
const lastSweptAt = new Map<string, number>();

/**
 * 新方式の候補を使ったことのあるリポジトリで、develop同期を確かめる巡回（#4641）。
 * 候補が完了・取消になった後も、同期済みと確かめられるまで同期PRを用意し直す
 */
export async function runDevelopSyncSweep(now = Date.now()): Promise<{ checked: number; unsynced: string[]; unknown: string[] }> {
  const rows = await db.releaseCandidate.findMany({ distinct: ["repositoryFullName"], select: { repositoryFullName: true } });
  const result = { checked: 0, unsynced: [] as string[], unknown: [] as string[] };
  for (const { repositoryFullName } of rows) {
    if (now - (lastSweptAt.get(repositoryFullName) ?? 0) < SWEEP_INTERVAL_MS) continue;
    lastSweptAt.set(repositoryFullName, now);
    const repository = await db.repository.findFirst({ where: { fullName: repositoryFullName, archived: false }, include: { installation: true } });
    if (!repository) continue;
    try {
      const token = await getInstallationToken(repository.installation.installationId);
      const status = await ensureDevelopSync({ owner: repository.ownerLogin, repo: repository.name, token });
      result.checked += 1;
      if (status.state === "unsynced") result.unsynced.push(repositoryFullName);
      if (status.state === "unknown") result.unknown.push(repositoryFullName);
    } catch (error) {
      console.error("[release-develop-sync] 巡回に失敗しました", repositoryFullName, error);
      result.unknown.push(repositoryFullName);
    }
  }
  return result;
}

/** テスト用: プロセス内の記録を消す */
export function resetDevelopSyncStateForTest(): void {
  createFailures.clear();
  lastSweptAt.clear();
}
