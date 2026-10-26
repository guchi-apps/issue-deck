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

import { evaluateReviewMergeGuard } from "@/lib/github/review-merge-guard";

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
  /** 自動マージの判定に使う観測（#4669）。取れなかったものは未設定のままにして、マージしない側へ倒す */
  headSha?: string;
  /** PR本文。自動レビューの判定（`## 検証結果`）を読む */
  body?: string | null;
  labels?: string[];
  /** 自動レビュー（`claude-review-develop.yml`）の判定が出揃い、レビューが実行済み・または不要で終わっているか */
  reviewSettled?: boolean;
};

/** 自動マージを止める人の確認ラベル（`22.merge-confirm-required`・`00.check-user`） */
const HOLD_LABELS = ["00.check-user", "22.merge-confirm-required"];

/**
 * 公開の証跡がある場合にだけ自動マージするファイル。ワークフローはdevelop向けのClaude自動レビューが
 * 走らないため、RCの公開経路を通ったことを記録で確かめる（#5081）。
 * コード・版ファイル（リポジトリごとに違う）は、HEADがmainの先端そのもので中身は公開済みなので止めない（#4731）
 */
const PUBLISH_EVIDENCE_FILE_PATTERNS = [/^\.github\/workflows\//];

const needsPublishEvidence = (file: string) => PUBLISH_EVIDENCE_FILE_PATTERNS.some((re) => re.test(file));

/** 自動マージに公開の証跡が要る変更を含むか（含むときだけ観測側が証跡を集める） */
export function developSyncNeedsPublishEvidence(files: string[]): boolean {
  return files.some(needsPublishEvidence);
}

/**
 * 今のmainがRCの公開経路で本番へ出たことの証跡（#5081）。ワークフローを含む同期PRでだけ集める。
 * - `publishedMergeSha`: 候補PRを本番mainへマージした記録（`ReleaseProductionCheck.mergeSha`）のうち、
 *   今のmainの先端と一致するもの。記録が無ければnull
 * - `mergeChangedFiles`: そのマージで変わったファイル（親コミット…マージの比較）。取得できなければnull
 */
export type DevelopSyncPublishEvidence = {
  publishedMergeSha: string | null;
  mergeChangedFiles: string[] | null;
};

/**
 * 自動マージの判定。止めるときの`waiting`は、条件が揃うのを巡回が待っている（CI実行中・レビュー判定中など）か、
 * 人の対応が要るか（false）を表す。画面はこれで「自動マージ待ち」と「人の確認が必要」を分ける
 */
export type DevelopSyncAutoMergeDecision = { ok: true; headSha: string } | { ok: false; reason: string; waiting: boolean };

const wait = (reason: string): DevelopSyncAutoMergeDecision => ({ ok: false, reason, waiting: true });
const hold = (reason: string): DevelopSyncAutoMergeDecision => ({ ok: false, reason, waiting: false });

/**
 * 同期PRを自動でマージしてよいか（#4669）。**止める側へ倒す**: 次のすべてを満たすときだけ`ok`。
 * - head が専用ブランチ（`release-sync/*`）。#4641以前のhead=mainの同期PRは対象外
 * - PRのHEADが元のmainそのもので、今のmainに追いついている（追いコミット・競合解消・mainの更新が無い）
 * - 競合が無く（mergeable=true）、CIが成功
 * - 自動レビューが終わっていて、要修正・要確認の判定が現在のHEADに残っていない
 * - 人の確認ラベルが付いていない
 * - ワークフローを含むなら、今のmainがRCの公開で本番へマージした記録と一致し、mainにだけあるワークフローが
 *   すべてそのマージで変わったものである（#5081。以前から未同期のワークフローや、記録の無いmainは人へ回す）
 * マージ操作は呼び出し側がこのHEADのSHAを渡して行う（追いコミットを巻き込まない）
 */
export function decideDevelopSyncAutoMerge(
  pr: DevelopSyncPullRequest,
  /** 今のmainの先端と、mainにだけある変更ファイル（同期PRの中身の範囲確認に使う） */
  main: { sha: string; files: string[] },
  evidence: DevelopSyncPublishEvidence | null = null,
): DevelopSyncAutoMergeDecision {
  if (!pr.headRef.startsWith(DEVELOP_SYNC_BRANCH_PREFIX)) return hold("専用ブランチの同期PRではありません");
  if (!pr.headSha) return wait("PRのHEADを取得できていません");
  // PRのHEADが元のmainそのもの（追いコミット・競合解消が無い）で、今のmainに追いついている場合だけ。
  // 中身は`main.files`と一致するので、証跡が要るファイル（ワークフロー）を含むかを見る
  if (pr.mainSha !== main.sha || pr.headSha !== pr.mainSha) return hold("PRのHEADがmainの先端と一致しません（追いコミットか、mainが進んでいます）");
  if (main.files.length === 0) return hold("差分がありません");
  if (pr.mergeable === null) return wait("GitHubがマージ可否を計算中です");
  if (pr.mergeable !== true) return hold("developと競合しています");
  if (pr.ciState === "pending") return wait("CIの完了を待っています");
  if (pr.ciState !== "success") return hold(pr.ciState === "failure" ? "CIが失敗しています" : "CIの状態を取得できません");
  if (pr.reviewSettled !== true) return wait("自動レビューの判定を待っています");
  const held = (pr.labels ?? []).find((l) => HOLD_LABELS.includes(l));
  if (held) return hold(`人の確認ラベル（${held}）が付いています`);
  const guard = evaluateReviewMergeGuard({ body: pr.body, headSha: pr.headSha, acknowledgeReviewSha: undefined });
  if (guard.status !== "ok") return hold(`自動レビューが${guard.reviewLabel}と判定しています`);
  const evidenceFiles = main.files.filter(needsPublishEvidence);
  if (evidenceFiles.length > 0) {
    const listed = filesSummary(evidenceFiles);
    if (evidence?.publishedMergeSha !== main.sha) {
      return hold(`ワークフローの変更（${listed}）を含み、今のmainがリリース候補の公開で本番へマージした記録と一致しません`);
    }
    // 照合できないものは自動マージ側へ倒さず、理由付きで人へ回す（次の巡回で取れれば自動マージへ戻る）
    if (evidence.mergeChangedFiles === null) return hold("公開のマージで変わったファイルを取得できず、ワークフローの変更を照合できません");
    const outside = evidenceFiles.filter((f) => !evidence.mergeChangedFiles!.includes(f));
    if (outside.length > 0) {
      return hold(`今回の公開で変わっていないワークフローの変更（${filesSummary(outside)}）を含みます（以前から未同期の変更です）`);
    }
  }
  return { ok: true, headSha: pr.headSha };
}

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
      /** ワークフローを含む同期PRを自動マージするための公開の証跡（#5081）。集めていなければnull */
      publishEvidence?: DevelopSyncPublishEvidence | null;
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
  | "merge_held"
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
  /** 開いている同期PRへの自動マージの判定（#5081）。同期PRが無ければnull */
  autoMerge: DevelopSyncAutoMergeDecision | null;
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
      autoMerge: null,
    };
  }
  const base = {
    mainSha: observation.mainSha,
    developSha: observation.developSha,
    mainOnlyFiles: observation.mainOnlyFiles,
    pullRequest: observation.openPullRequest,
    autoMerge: observation.openPullRequest
      ? decideDevelopSyncAutoMerge(
          observation.openPullRequest,
          { sha: observation.mainSha, files: observation.mainOnlyFiles },
          observation.publishEvidence ?? null,
        )
      : null,
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
  // 巡回が自動でマージできない理由が確定しているときは、人の対応が要る停止として理由と次の操作を出す（#5081）
  const autoMerge = base.autoMerge;
  if (autoMerge && !autoMerge.ok && !autoMerge.waiting) {
    return unsynced(
      "merge_held",
      "同期PRは人の確認が必要です",
      `${files}。${prLabel} は自動でマージされません: ${autoMerge.reason}${stale}`,
      `${prLabel} の内容を確認し、問題なければマージコミットでマージしてください`,
    );
  }
  const waitingFor = autoMerge && !autoMerge.ok ? `（${autoMerge.reason}）` : "";
  return unsynced(
    "awaiting_merge",
    "同期PRの自動マージ待ちです",
    `${files}。${prLabel} は巡回が自動でマージします${waitingFor}${stale}`,
    `操作は不要です。巡回（約5分ごと）が条件（CI成功・競合なし・自動レビュー完了）を確かめて ${prLabel} を自動でマージします`,
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
