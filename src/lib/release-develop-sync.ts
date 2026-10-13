/**
 * 本番公開後のdevelop同期（#4641）の判定。GitHubの観測（`release-develop-sync-run.ts`）を受け取り、
 * 同期済み・未同期・判定不能と、画面に出す理由・次の操作を決める純関数。
 *
 * **判定の正は実際のGit履歴で、DBの記録（版の予約・公開準備）は見ない。** 記録が欠けた手動公開・
 * 取消・外部マージでも、mainにだけある変更が残っていれば未同期になる。
 *
 * 同期済みとみなすのは次のどれかだけ:
 * 1. mainの先端がdevelopの祖先（`develop...main`の`aheadBy`が0）
 * 2. 祖先でなくても、`develop...main`の3点比較で変更ファイルが0（旧方式のマージコミットだけがmainにある）
 * 3. マージ済みの同期PR（本文の印に元のmain SHA）があり、そのSHA以降mainに変更ファイルが無い
 *    （同期PRをsquash・rebaseでマージした場合。merge-baseが進まないため1・2では同期済みにならない）
 *
 * 取得できなかったものは**同期済みと推定しない**（判定不能として次の候補の作成を止める）。
 */

export const DEVELOP_SYNC_BRANCH_PREFIX = "release-sync/";

/** 同期PRのhead。mainの先端から切る専用ブランチで、名前がmainのSHAで決まるので同じ同期を二重に作らない */
export function developSyncBranchName(mainSha: string): string {
  return `${DEVELOP_SYNC_BRANCH_PREFIX}main-${mainSha.slice(0, 12)}`;
}

/** 同期PRの本文に残す、元にしたmainのSHAの印 */
export function developSyncMarker(mainSha: string): string {
  return `<!-- issue-deck-develop-sync:main=${mainSha} -->`;
}

export function parseDevelopSyncMarker(body: string | null | undefined): string | null {
  const match = /issue-deck-develop-sync:main=([0-9a-f]{40})/.exec(body ?? "");
  return match ? match[1] : null;
}

/** 同期PRのhead。専用ブランチと、#4641以前のhead=mainの同期PR（既存のものを重複させない） */
export function isDevelopSyncHeadRef(ref: string): boolean {
  return ref === "main" || ref.startsWith(DEVELOP_SYNC_BRANCH_PREFIX);
}

export type DevelopSyncPullRequest = {
  number: number;
  url: string;
  headRef: string;
  /** 同期PRが元にしたmainのSHA。head=mainの旧い同期PRは印が無くnull */
  mainSha: string | null;
  ciState: "pending" | "success" | "failure" | "unknown";
  /** GitHubの計算前はnull。falseのときだけ競合として扱う */
  mergeable: boolean | null;
};

export type DevelopSyncObservation =
  | { kind: "unreadable"; reason: string }
  | {
      kind: "observed";
      mainSha: string;
      developSha: string;
      /** mainの先端がdevelopの祖先か */
      mainInDevelop: boolean;
      /** `develop...main`の3点比較で変わったファイル（mainにだけある変更） */
      mainOnlyFiles: string[];
      /** squash・rebaseでマージ済みの同期PRが、今のmainの変更を全て含むとき、そのPR番号 */
      squashCoveredBy: number | null;
      /** 開いている同期PR（無ければnull） */
      openPullRequest: DevelopSyncPullRequest | null;
      /** 今のmainに対して同期PRを作れなかった直近の理由（無ければnull） */
      createFailure: string | null;
    };

export type DevelopSyncDetail =
  | "ancestor"
  | "merge_commits_only"
  | "squash_merged"
  | "no_pull_request"
  | "create_failed"
  | "conflict"
  | "ci_failure"
  | "ci_pending"
  | "awaiting_merge"
  | "unreadable";

export type DevelopSyncStatus = {
  state: "synced" | "unsynced" | "unknown";
  detail: DevelopSyncDetail;
  label: string;
  reason: string;
  /** 人が次にやること。同期済みならnull */
  nextAction: string | null;
  /** 画面から同期PRの作成（再試行）を押せるか */
  canCreate: boolean;
  mainSha: string | null;
  developSha: string | null;
  /** mainにだけある変更ファイル（画面には先頭の数件だけ出す） */
  mainOnlyFiles: string[];
  pullRequest: DevelopSyncPullRequest | null;
};

const short = (sha: string) => sha.slice(0, 7);

function filesSummary(files: string[]): string {
  const head = files.slice(0, 5).join("、");
  return files.length > 5 ? `${head} ほか${files.length - 5}件` : head;
}

export function decideDevelopSync(observation: DevelopSyncObservation): DevelopSyncStatus {
  if (observation.kind === "unreadable") {
    return {
      state: "unknown",
      detail: "unreadable",
      label: "同期状態を判定できません",
      reason: observation.reason,
      nextAction: "再取得してください。判定できるまで次の候補は作りません（同期済みとはみなしません）",
      canCreate: false,
      mainSha: null,
      developSha: null,
      mainOnlyFiles: [],
      pullRequest: null,
    };
  }
  const base = {
    mainSha: observation.mainSha,
    developSha: observation.developSha,
    mainOnlyFiles: observation.mainOnlyFiles,
    pullRequest: observation.openPullRequest,
  };
  const synced = (detail: DevelopSyncDetail, reason: string): DevelopSyncStatus => ({
    ...base,
    state: "synced",
    detail,
    label: "developへ同期済み",
    reason,
    nextAction: null,
    canCreate: false,
  });
  if (observation.mainInDevelop) return synced("ancestor", `main ${short(observation.mainSha)} はdevelopに含まれています`);
  if (observation.mainOnlyFiles.length === 0) {
    return synced("merge_commits_only", `mainにだけあるのはマージコミットだけで、developへ戻す変更はありません（main ${short(observation.mainSha)}）`);
  }
  if (observation.squashCoveredBy !== null) {
    return synced("squash_merged", `同期PR #${observation.squashCoveredBy} で、main ${short(observation.mainSha)} までの変更をdevelopへ取り込み済みです`);
  }

  const files = `mainにだけある変更が${observation.mainOnlyFiles.length}ファイルあります（${filesSummary(observation.mainOnlyFiles)}）`;
  const pr = observation.openPullRequest;
  const unsynced = (detail: DevelopSyncDetail, label: string, reason: string, nextAction: string, canCreate = false): DevelopSyncStatus => ({
    ...base,
    state: "unsynced",
    detail,
    label,
    reason,
    nextAction,
    canCreate,
  });
  if (pr === null) {
    if (observation.createFailure !== null) {
      return unsynced(
        "create_failed",
        "同期PRを作成できません",
        `${files}。同期PRの作成に失敗しました: ${observation.createFailure}`,
        "「同期PRを作成」で再試行してください（巡回も自動で再試行します）",
        true,
      );
    }
    return unsynced("no_pull_request", "developへ未同期", `${files}。同期PRはまだありません`, "「同期PRを作成」を押してください（巡回も自動で作成します）", true);
  }
  // 同期PRの作成後にmainが進んだときは、このPRのマージ後に残りの同期PRを作る（同時に2本は作らない）
  const stale = pr.mainSha !== null && pr.mainSha !== observation.mainSha ? `。同期PRの作成後にmainが進んだため、マージ後に残りを同期する同期PRを作ります` : "";
  const prLabel = `同期PR #${pr.number}`;
  if (pr.mergeable === false) {
    return unsynced(
      "conflict",
      "同期PRが競合しています",
      `${files}。${prLabel} がdevelopと競合しています${stale}`,
      `${prLabel} のブランチ（${pr.headRef}）へdevelopを取り込んで競合を解消し、マージしてください。mainへは直接pushしません`,
    );
  }
  if (pr.ciState === "failure") {
    return unsynced("ci_failure", "同期PRのCIが失敗しています", `${files}。${prLabel} のCIが失敗しています${stale}`, `${prLabel} のCIの失敗を確認し、同期ブランチで修正してください`);
  }
  if (pr.ciState === "pending") {
    return unsynced("ci_pending", "同期PRのCIを実行中です", `${files}。${prLabel} のCIの完了を待っています${stale}`, `CIの完了後に ${prLabel} をマージしてください`);
  }
  return unsynced(
    "awaiting_merge",
    "同期PRのマージ待ちです",
    `${files}。${prLabel} がマージされるのを待っています${stale}`,
    `${prLabel} をマージコミットでマージしてください（レビュー・CIの保護はそのまま通ります）`,
  );
}

/** 次の候補の作成を止める理由。同期済みならnull（未同期・判定不能のどちらも止める） */
export function developSyncCreateError(status: DevelopSyncStatus): { error: "develop_not_synced" | "develop_sync_unknown"; message: string } | null {
  if (status.state === "synced") return null;
  if (status.state === "unknown") {
    return { error: "develop_sync_unknown", message: `前回の公開がdevelopへ戻っているか判定できないため、候補を作りません。${status.reason}` };
  }
  return { error: "develop_not_synced", message: `前回の公開がdevelopへ戻っていないため、候補を作りません。${status.reason}。${status.nextAction}` };
}
