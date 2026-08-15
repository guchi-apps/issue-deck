"use client";

import { useEffect, useState } from "react";

import { releaseErrorMessage, requestRelease } from "@/lib/release-request";
import type { BumpKind } from "@/lib/semver-bump";

/** CIの集約状態。`unknown`は権限不足やチェック未検出で判定できないことを表す */
export type CiState = "pending" | "success" | "failure" | "unknown";

export type ReleasePullRequest = {
  number: number;
  url: string;
  title: string;
  ciState: CiState | null;
  /**
   * コンフリクトの有無。GitHubが判定中・取得できなかった場合はnull（#1293）。
   * `false`のときだけ「コンフリクトあり」と自動解消ボタンを出す。
   */
  mergeable: boolean | null;
};

export type BumpPullRequest = ReleasePullRequest & {
  /** バンプPRのブランチ名から取り出した次バージョン（例: "1.2.3"）。取得できない場合はnull */
  version: string | null;
  /** バンプPR本文の「## バージョンの判断根拠」セクションから抜き出した判断根拠。取得できない場合はnull */
  reason: string | null;
  /**
   * バンプPR本文の「## 更新履歴（生成された利用者向け文言）」セクションから抜き出した更新履歴。
   * "version" npm lifecycleスクリプトで更新履歴を消費する仕組みを導入していないリポジトリでは
   * このセクション自体がPR本文に現れないためnull
   */
  changelog: string | null;
};

export type ReleaseWorkflowRun = {
  /** queued | in_progress | completed など */
  status: string;
  /** success | failure | cancelled | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
};

/** バンプPR自身を除いた、develop向けのその他のオープンPR（#977） */
export type OtherPullRequest = {
  number: number;
  url: string;
  title: string;
  /** タイトル・本文から抽出した参照Issue番号（見つからない場合は空配列） */
  issueNumbers: number[];
};

/** リリース進行の論理段階。詳細はAPI(route.ts)側のコメントを参照 */
export type ReleasePhase = "none" | "bump_pr_open" | "release_pending" | "release_pr_open";

export type ReleaseStatus =
  | { available: false }
  | {
      available: true;
      mainVersion: string | null;
      developVersion: string | null;
      phase: ReleasePhase;
      workflowRun: ReleaseWorkflowRun | null;
      /** mainブランチ上の本番デプロイworkflow（deploy.yml）の最新実行。mainへのマージ後の見届けに使う(#392) */
      deployWorkflowRun: ReleaseWorkflowRun | null;
      bumpPullRequest: BumpPullRequest | null;
      releasePullRequest: ReleasePullRequest | null;
      otherPullRequests: OtherPullRequest[];
    };

/** 取得側のエラー文言。起動側（`requestRelease`）と同じ関数を使う（#1510） */
const errorMessageForResponse = releaseErrorMessage;

/**
 * シートを開いている間のポーリング間隔（ミリ秒）。
 * 1回の取得でGitHub APIを7〜8回消費するため、自動で状態が進む段階（workflow実行中・CI待ちなど）
 * だけ短い間隔でライブ更新し、人のマージ待ち・対象なしの段階では長い間隔に落とす。
 */
const ACTIVE_POLL_INTERVAL_MS = 10_000;
const IDLE_POLL_INTERVAL_MS = 30_000;

/** 放置していても自動で状態が進む段階かどうか（＝短い間隔でのポーリングに意味がある段階か） */
function isProgressing(status: ReleaseStatus | null): boolean {
  if (!status || !status.available) return false;
  if (status.workflowRun && status.workflowRun.status !== "completed") return true;
  if (status.deployWorkflowRun && status.deployWorkflowRun.status !== "completed") return true;
  if (status.bumpPullRequest?.ciState === "pending") return true;
  // develop→mainのPRが自動作成されるのを待っている過渡状態
  return status.phase === "release_pending";
}

export function useReleaseStatus(
  repoFullName: string | null,
  enabled: boolean,
  idlePollIntervalMs?: number,
) {
  const [data, setData] = useState<ReleaseStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  // triggerRelease成功時などに即時再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled || !repoFullName) return;

    const [owner, repo] = repoFullName.split("/");
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    /** 取得中かどうか。タブ復帰時の即時取得が二重に走るのを防ぐ */
    let inFlight = false;
    /** 直近の取得結果。次のポーリング間隔の決定に使う */
    let lastStatus: ReleaseStatus | null = null;

    // initial=true の初回のみローディング表示・data初期化を行う。以降のポーリング更新では
    // 画面をちらつかせないよう、取得済みdataを保ったまま差し替える。
    async function load(initial: boolean): Promise<ReleaseStatus | null> {
      if (initial) {
        setIsLoading(true);
        setData(null);
        setError(null);
      }
      try {
        const res = await fetch(
          `/api/repositories/release?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errorMessageForResponse(res.status, json.error, json.message));
        if (!cancelled) {
          setData(json as ReleaseStatus);
          setError(null);
        }
        return json as ReleaseStatus;
      } catch (err) {
        // ポーリング中の一時的な失敗で既存の表示を消さないよう、初回のみエラーを表面化する。
        if (!cancelled && initial) setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        if (!cancelled && initial) setIsLoading(false);
      }
    }

    const idleIntervalMs = idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS;

    function schedule() {
      if (cancelled) return;
      timerId = setTimeout(poll, isProgressing(lastStatus) ? ACTIVE_POLL_INTERVAL_MS : idleIntervalMs);
    }

    async function runOnce(initial: boolean) {
      inFlight = true;
      try {
        // 取得に失敗した場合は直前の状態を保ったまま次の間隔を決める（失敗を理由に間隔を変えない）
        lastStatus = (await load(initial)) ?? lastStatus;
      } finally {
        inFlight = false;
      }
      schedule();
    }

    function poll() {
      // バックグラウンドタブでは取得せず次の周期だけ進める（復帰時にvisibilitychangeで即時取得する）
      if (document.hidden) {
        timerId = setTimeout(poll, idleIntervalMs);
        return;
      }
      void runOnce(false);
    }

    function handleVisibilityChange() {
      // 取得中の復帰では新たに走らせない（ポーリングの連鎖が二重になるのを防ぐ）
      if (document.hidden || inFlight) return;
      clearTimeout(timerId);
      poll();
    }

    // 開いた瞬間に外部システム（GitHub API）から取得し、以降は状況に応じた間隔でライブ更新する。
    void runOnce(true);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, repoFullName, reloadKey, idlePollIntervalMs]);

  /** `bumpKind`を渡すとバージョンの上げ幅を指定する。省略時は自動判定（#1548） */
  async function triggerRelease(bumpKind?: BumpKind): Promise<boolean> {
    if (!repoFullName) return false;

    setIsTriggering(true);
    setError(null);
    try {
      // 起動そのものは「ブランチとPRの流れ」画面のボタンと同じ関数を通す（#1510）
      await requestRelease(repoFullName, bumpKind);
      // 起動直後に状態を取り直して、実行中runやバンプPRの出現を素早く反映する。
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsTriggering(false);
    }
  }

  return { data, isLoading, error, triggerRelease, isTriggering };
}
