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
    repoFullNames.map((repoFullName) => requestRelease(repoFullName)),
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
};

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
