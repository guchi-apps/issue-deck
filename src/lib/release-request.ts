/**
 * リリースworkflowの起動リクエスト（#1510）。
 *
 * 起動の導線は2か所ある——PCの「ブランチ」画面の「リリースする」
 * （`repository-release-button.tsx`）と、スマホのリリースシート（`mobile-release-sheet.tsx`）。
 * PCヘッダーのロケットボタンは#1614で通知ベルへ置き換えたため、起動の導線ではなくなった。
 * **叩くエンドポイントもエラーの読み方も1か所に置く**ことで、どちらから押しても同じ結果に
 * なることを保つ。流れ画面のボタンは状態取得（`useReleaseStatus`）を必要としないため、
 * ポーリングを持つフックごと持ち込まずにこの関数だけを使う。
 */

import type { ReleaseRebuildCandidate } from "@/lib/release-rebuild";
import type { RebuildSelectionOptions } from "@/lib/release-rebuild-selection-run";
import type { DevelopSyncStatus } from "@/lib/release-develop-sync";
import type { RcBlockSummary } from "@/lib/release-rc";
import type { ReleaseStartMode } from "@/lib/release-start-mode";
import type { BumpKind } from "@/lib/semver-bump";

/** エラーコードを画面に出す文言へ直す。`useReleaseStatus`の取得側と同じ文面に揃えている */
export function releaseErrorMessage(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_reauth_required") {
    return "GitHub連携が必要です。再ログインしてください。";
  }
  // リリース用workflowを持たないリポジトリ（#1538）。GitHubの生の404本文を出しても
  // 何が足りないのか読み取れないため、必要なファイル名まで含めて言い切る。
  if (errorCode === "release_workflow_missing") {
    return "このリポジトリにはリリース用workflow（release-develop-to-main.yml）がありません。";
  }
  if (errorCode === "deploy_failed") {
    return "本番デプロイが失敗しています。修正をdevelopへ取り込んだ場合は、確認画面で上書きを指定して起動してください。";
  }
  if (errorCode === "release_already_running") {
    return "リリース準備がすでに受け付けられているか、実行中です。完了するまでお待ちください（GitHub Actionsの実行状況で確認できます）。";
  }
  if (errorCode === "release_state_unknown") {
    return "リリース準備の実行状況をGitHubから確認できませんでした。少し待って、もう一度押してください。";
  }
  if (errorCode === "failed_deploy_override_unsupported") {
    return "このリポジトリのリリースworkflowは失敗中の手動上書きに未対応です。workflowを更新してください。";
  }
  // 上げ幅の指定（`bump_kind`）を受け取れない世代のworkflowを持つリポジトリ（#1548）。
  // GitHubは`Unexpected inputs provided`の422で落とすが、そのままでは何をすればよいか読めない。
  if (errorCode === "bump_kind_unsupported") {
    return "このリポジトリのリリースworkflowは上げ幅の指定に未対応です。自動判定で起動してください。";
  }
  // リリースの作り直し（#3014）。どれも「次に何をすればよいか」まで言い切る。
  if (errorCode === "release_pr_changed") {
    return "リリースPRが変わっています（マージ・作り直し済みの可能性があります）。画面を更新してください。";
  }
  if (errorCode === "nothing_to_rebuild") {
    return "リリースPRの後にdevelopへ入った変更が無いため、作り直しても中身が変わりません。";
  }
  if (errorCode === "rebuild_dispatch_bump_kind_unsupported") {
    return "リリースPRは閉じましたが、このリポジトリのリリースworkflowは上げ幅の指定に未対応です。「リリースする」から自動判定で起動し直してください。";
  }
  if (errorCode === "rebuild_dispatch_failed") {
    return "リリースPRは閉じましたが、リリースworkflowの起動に失敗しました。「リリースする」から起動し直すと作り直されます。";
  }
  // PRを選んだ作り直し（#4335）
  if (errorCode === "selection_required") {
    return "このリポジトリでは、元の候補へ足すPRを選んで作り直します。足すPRを1件以上選んでください。";
  }
  if (errorCode === "empty_selection") {
    return "足すPRが選ばれていません。";
  }
  if (errorCode === "selection_unsupported") {
    return "このリポジトリのリリースworkflowはPRを選んだ作り直しに未対応です。workflowを更新してください。";
  }
  if (errorCode === "rebuild_in_progress") {
    return "この候補への作り直しは既に起動しています。リリース画面の進捗を確認してください。";
  }
  if (errorCode === "dispatch_failed") {
    return "リリースworkflowを起動できませんでした。元の候補はそのままです。時間をおいて押し直してください。";
  }
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

/**
 * `POST /api/repositories/release`。成功すれば何も返さず、失敗すれば
 * {@link releaseErrorMessage} の文言を持つ`Error`を投げる。
 *
 * `bumpKind`を渡すとバージョンの上げ幅をworkflowへ指定する（#1548）。**渡さない場合は
 * 従来どおりinput無しでdispatchし、workflow内のClaudeがコード差分から判定する。**
 */
export async function requestRelease(
  repoFullName: string,
  bumpKind?: BumpKind,
  allowFailedDeploy = false,
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");

  const res = await fetch("/api/repositories/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner,
      repo,
      ...(bumpKind ? { bumpKind } : {}),
      ...(allowFailedDeploy ? { allowFailedDeploy: true } : {}),
    }),
  });
  const json: { error?: string; message?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(releaseErrorMessage(res.status, json.error, json.message));
}

/** 起動の直前に、表示後に作られた既存候補が見つかった（#4628）。文言だけでなく既存候補と次の操作を画面へ渡す */
export class ReleaseBlockedError extends Error {
  constructor(readonly block: RcBlockSummary) {
    super(`${block.label}: ${block.reason}`);
    this.name = "ReleaseBlockedError";
  }
}

/** 候補作成（`POST /api/repositories/release/rc` action=create）の失敗コードを画面の文言へ直す（#4604） */
export function releaseCandidateErrorMessage(errorCode: string | undefined, message: string | undefined): string {
  switch (errorCode) {
    case "caller_unsupported":
      return "このリポジトリのリリースworkflowは新方式（候補の作成）に未対応です。callerを更新してください。";
    case "rc_active":
      return "進行中のリリース候補があります。新しい候補は作らず、その候補の検証・修正・公開準備へ進んでください。";
    case "legacy_open":
      return "旧方式のリリース候補が開いています。旧方式のまま完了させるか、候補の画面で「新方式へ移行」を選んでください。";
    case "nothing_to_release":
      return message ?? "出す変更がありません。";
    case "develop_not_synced":
      return message ?? "前回の公開がdevelopへ反映されていません。同期のPRをマージしてから候補を作ってください。";
    case "develop_sync_unknown":
      return message ?? "前回の公開がdevelopへ反映されているか判定できないため、候補を作りませんでした。時間をおいて再確認してください。";
    case "dispatch_failed":
      return "候補の作成workflowを起動できませんでした。時間をおいて押し直してください。";
    case "github_reauth_required":
      return "GitHub連携が必要です。再ログインしてください。";
    default:
      return message ?? "リリース候補を作成できませんでした。";
  }
}

/**
 * 新方式の開始操作（#4604）。developの先端を固定した候補を作り、全体レビュー・統合検証へ進める。
 * **正式バンプはここでは行わない**（合格後の公開準備で初めて行う）。
 *
 * `requestKey`は操作ごとに1つ作り、再送では同じ値を送る（サーバーが既存の候補を返し、二重候補を作らない）。
 * 成功すると作られた（または既存の）候補のIDを返す
 */
export async function requestReleaseCandidate(
  repoFullName: string,
  requestKey: string = newRequestKey(),
): Promise<{ candidateId: string; existing: boolean }> {
  const [owner, repo] = repoFullName.split("/");
  const res = await fetch("/api/repositories/release/rc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, action: "create", requestKey }),
  });
  const json: { ok?: boolean; error?: string; message?: string; candidateId?: string; existing?: boolean; block?: RcBlockSummary } =
    await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false || !json.candidateId) {
    if (json.error === "rc_active" && json.block) throw new ReleaseBlockedError(json.block);
    throw new Error(releaseCandidateErrorMessage(json.error, json.message));
  }
  return { candidateId: json.candidateId, existing: json.existing === true };
}

/** 要求キー（`/^[A-Za-z0-9_-]{8,48}$/`）。操作ごとに作り、再送では使い回す */
export function newRequestKey(): string {
  return `rc-${globalThis.crypto.randomUUID()}`;
}

export type ReleaseStartModes = Record<string, ReleaseStartMode>;

/** `GET /api/repositories/release/start-mode`。取得できなければ全て`unknown`（旧方式を黙って起動しない） */
export async function fetchReleaseStartModes(repoFullNames: string[]): Promise<ReleaseStartModes> {
  const unknown: ReleaseStartMode = { mode: "unknown", label: "新方式に対応しているか取得できませんでした" };
  const fallback = Object.fromEntries(repoFullNames.map((name) => [name, unknown]));
  try {
    const res = await fetch(`/api/repositories/release/start-mode?repos=${encodeURIComponent(repoFullNames.join(","))}`);
    if (!res.ok) return fallback;
    const json: { modes?: ReleaseStartModes } = await res.json();
    return Object.fromEntries(repoFullNames.map((name) => [name, json.modes?.[name] ?? unknown]));
  } catch {
    return fallback;
  }
}

export type ReleaseStartResult = { kind: "candidate"; candidateId: string; existing: boolean } | { kind: "legacy" };

/**
 * 通常の開始操作の入口（#4604・#4623）。個別・スマホ・一括がすべてここを通り、**判定を揃える**。
 * 開始方式は起動の直前にサーバーから取り直す（画面の表示が古くても未対応repoへ誤って起動しない）。
 *
 * - 新方式対応: 候補を作る
 * - 未対応・判定不能: **旧方式へ落とさず**起動しない（原因と更新手順を例外の文言に含める）
 * - 例外: `allowFailedDeploy`（本番デプロイ失敗中の修正リリース）は新方式の候補作成が扱えないため、
 *   確認のうえ明示した場合に限り旧方式で起動する。回復手段を失わないための例外で、通常開始ではない
 */
export async function requestReleaseStart(
  repoFullName: string,
  options: { bumpKind?: BumpKind; allowFailedDeploy?: boolean; requestKey?: string },
): Promise<ReleaseStartResult> {
  if (options.allowFailedDeploy) {
    await requestRelease(repoFullName, options.bumpKind, true);
    return { kind: "legacy" };
  }
  const mode = (await fetchReleaseStartModes([repoFullName]))[repoFullName];
  if (mode.mode === "candidate") {
    return { kind: "candidate", ...(await requestReleaseCandidate(repoFullName, options.requestKey)) };
  }
  if (mode.mode === "blocked") throw new ReleaseBlockedError(mode.block);
  throw new Error(mode.label);
}

/**
 * 公開内容をdevelopへ戻す同期PRを用意する（`POST /api/repositories/release/rc` action=develop_sync。#4641）。
 * 同期済み・同期PRが開いていればサーバーは何も作らず、今の状況を返す
 */
export async function requestDevelopSync(repoFullName: string): Promise<DevelopSyncStatus> {
  const [owner, repo] = repoFullName.split("/");
  const res = await fetch("/api/repositories/release/rc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, action: "develop_sync" }),
  });
  const json: { ok?: boolean; developSync?: DevelopSyncStatus; message?: string } = await res.json().catch(() => ({}));
  if (res.ok && json.developSync) return json.developSync;
  throw new Error(json.message ?? `同期PRを用意できませんでした (${res.status})`);
}

/**
 * 既存候補の管理記録を終了する（`POST /api/repositories/release/rc` action=cancel。#4628）。
 * `expectedPhase`は画面で見ていた段階で、変わっていればサーバーが取り消さない。履歴・公開済みコードは残る
 */
export async function requestReleaseCandidateCancel(repoFullName: string, block: RcBlockSummary, reason: string): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const res = await fetch("/api/repositories/release/rc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, action: "cancel", candidateId: block.candidateId, expectedPhase: block.phase, reason }),
  });
  const json: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
  if (res.ok && json.ok !== false) return;
  if (json.error === "candidate_changed") throw new Error("候補の状態が変わっています。再確認してから操作してください。");
  if (json.error === "not_cancellable") throw new Error(json.message ?? "この候補は終了できません。");
  throw new Error(json.message ?? `終了できませんでした (${res.status})`);
}

/**
 * 稼働確認が止まった公開済み候補を確かめ直す（#4712）。サーバーは待ち時間を今から取り直して1巡確かめるだけで、
 * 証拠を代わりに書かない（確かめられなければまた理由付きで止まる）
 */
export async function requestRcProductionRecheck(repoFullName: string, candidateId: string): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const res = await fetch("/api/repositories/release/rc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, action: "recheck_production", candidateId }),
  });
  const json: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
  if (res.ok && json.ok !== false) return;
  if (json.error === "not_stopped") throw new Error("稼働確認は止まっていません。状態を取り直してください。");
  throw new Error(`稼働確認をやり直せませんでした (${res.status})`);
}

export type ReleaseBulkResult = {
  /** 起動できたリポジトリのフル名 */
  succeeded: string[];
  /** 起動に失敗したリポジトリと、その理由（{@link releaseErrorMessage}の文言） */
  failed: { repoFullName: string; message: string }[];
};

/**
 * 複数リポジトリのリリースworkflowをまとめて起動する（#2770）。
 *
 * **専用の一括起動APIは持たない。** {@link requestRelease}を対象ぶんループするだけにして、
 * `POST /api/repositories/release`が持つ前処理（`previewModeGuard`・workflow存在確認）と
 * エラー整形を二重に持たない（計画レビューの指摘を受けた判断。1件ずつ`Promise.allSettled`で
 * 呼ぶため、一部のリポジトリが失敗しても他は起動できる）。
 */
export async function requestReleaseBulk(repoFullNames: string[]): Promise<ReleaseBulkResult> {
  const results = await Promise.allSettled(
    // 旧方式を黙って起動しない（#4604・#4623）。未対応・判定不能のrepoは理由つきで失敗に載せる
    repoFullNames.map((repoFullName) => requestReleaseStart(repoFullName, {})),
  );
  const succeeded: string[] = [];
  const failed: { repoFullName: string; message: string }[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      succeeded.push(repoFullNames[index]);
    } else {
      const reason = result.reason;
      failed.push({
        repoFullName: repoFullNames[index],
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  return { succeeded, failed };
}

/** 作り直しの確認ダイアログに出す材料（`GET /api/repositories/release/rebuild`。#3014） */
export type ReleaseRebuildInfo = {
  releasePullRequest: { number: number; title: string; url: string; version: string; headSha?: string } | null;
  candidate: ReleaseRebuildCandidate | null;
  /** PRを選んだ作り直し（#4335）の材料。リリースPRが無ければ無い */
  selection?: RebuildSelectionOptions;
  /** 旧方式のリリースPRが無く、新方式の候補（`release-rc/<番号>`。#4495）が開いているときの候補PR（#4895） */
  rcPullRequest?: { number: number; url: string; label: string } | null;
};

/** 新方式の候補の「再取り込み・再確認」の結果（`POST /api/repositories/release/rc` action=recover。#4895） */
export type RcFixRecoveryResponse = {
  resumed: number[];
  requeued: number[];
  blocked: { issueNumber: number; reason: string }[];
};

export async function requestRcFixRecovery(repoFullName: string, pullRequestNumber: number): Promise<RcFixRecoveryResponse> {
  const [owner, repo] = repoFullName.split("/");
  const res = await fetch("/api/repositories/release/rc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, action: "recover", pullRequestNumber }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(releaseErrorMessage(res.status, json.error, json.message));
  return json as RcFixRecoveryResponse;
}

export async function fetchReleaseRebuild(repoFullName: string): Promise<ReleaseRebuildInfo> {
  const [owner, repo] = repoFullName.split("/");
  const params = new URLSearchParams({ owner, repo });
  const res = await fetch(`/api/repositories/release/rebuild?${params}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(releaseErrorMessage(res.status, json.error, json.message));
  return json as ReleaseRebuildInfo;
}

/**
 * `POST /api/repositories/release/rebuild`（#3014）。リリースPRを閉じ、リリースworkflowを
 * 起動し直す。`pullRequestNumber`はダイアログで見ていたリリースPRで、変わっていれば409になる。
 */
export async function requestReleaseRebuild(
  repoFullName: string,
  pullRequestNumber: number,
  bumpKind?: BumpKind,
  /** PRを選んだ作り直し（#4335）。ダイアログで見ていた元の候補のheadと、選んだPRのマージコミット */
  selective?: { headSha: string; pullRequests: { number: number; mergeSha: string | null }[] },
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const res = await fetch("/api/repositories/release/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner,
      repo,
      pullRequestNumber,
      ...(bumpKind ? { bumpKind } : {}),
      ...(selective ? { headSha: selective.headSha, selectedPullRequests: selective.pullRequests } : {}),
    }),
  });
  const json: { error?: string; message?: string; problems?: { number: number; label: string }[] } = await res
    .json()
    .catch(() => ({}));
  if (!res.ok) {
    // 選べないPRがあったときは、PRごとの理由を並べる（選択は自動では広げない）
    if (json.error === "invalid_selection" && json.problems?.length) {
      throw new Error(`選んだPRを足せません: ${json.problems.map((p) => `#${p.number} ${p.label}`).join(" / ")}`);
    }
    throw new Error(releaseErrorMessage(res.status, json.error, json.message));
  }
}
