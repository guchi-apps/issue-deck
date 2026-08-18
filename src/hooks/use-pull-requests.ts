"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import type { AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import type {
  PullRequestListResponse,
  PullRequestListScope,
  PullRequestSummary,
} from "@/types/pull-request";

type UsePullRequestsResult = {
  pullRequests: PullRequestSummary[];
  /** 取得に失敗したリポジトリのfullName（部分的な欠落を画面に出すため） */
  failedRepositories: string[];
  /** 最終取得時刻（ISO8601）。未取得はnull */
  fetchedAt: string | null;
  /**
   * 手元にある取得結果の母集団（#1711）。未取得はnull。
   *
   * **`scope`に`all`を要求しても、実際にクローズ済みまで届くのは次の取得が終わってから。**
   * それまでは`open`のときの結果が残るため、要求した`scope`を見て「クローズ済みも揃っている」
   * と判断すると、まだ入っていないものを「無い」と読んでしまう（ブランチ画面がリリース済みの
   * バージョンを1件も出せなくなっていた）。
   */
  loadedScope: PullRequestListScope | null;
  isLoading: boolean;
  /**
   * 取得が飛んでいる間は自動更新でも真になる（#1767）。読み込み表示（更新ボタンの無効化・
   * 「読み込み中...」）は`isLoading`のまま据え置き、**更新アイコンの回転だけ**をこちらで
   * 出すため。自動更新でも回るようにしないと、画面は勝手に変わるのに何も起きていないように
   * 見える。
   */
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * 自動更新と同じ扱いでの取り直し（#1909）。読み込み表示を出さず、失敗も画面に出さない。
   *
   * **通知ベルを開いている間の30秒ごとの取り直しはこちらを使う。** `refresh`は取得effectを
   * 張り直すため`isLoading`が立ち、後ろに開いているPR一覧が30秒ごとに「読み込み中...」へ
   * 戻ってしまう。
   */
  refreshInBackground: () => void;
  /**
   * ユーザーの操作（一覧を下へ引っ張る）による取り直し（#1947）。
   *
   * `refreshInBackground`との違いは2つで、どちらも**更新ボタンを外した以上、
   * 引っ張った結果が嘘にならないため**に要る。
   *
   * - **取得が飛んでいる最中は、その取得の完了を待って返す。** 何もせず返すと、自動更新と
   *   重なったときに「更新中…」が最短表示時間ぶん回っただけで終わり、取り直していないのに
   *   取り直したように見える。
   * - **失敗を`error`に出す。** 自動更新の失敗は次の周期で回復するので黙るが、ユーザーが
   *   自分で引っ張った取得は、レート制限やトークン失効で落ちても画面に何も出ないと
   *   「引っ張っても何も起きない」としか見えない。
   */
  refreshFromPull: () => Promise<void>;
};

/**
 * Pull Requestをリポジトリ横断で取得する。
 *
 * `scope`が`open`ならマージ待ちのPRだけ、`all`ならクローズ済み（マージ済み・却下）も直近ぶんだけ
 * 含める（#1312）。**再取得が走るのは母集団が広がったときだけ**で、「処理中」「完了」の
 * ビュー切り替えは同じ取得結果をクライアント側で絞るだけなのでGitHub APIを叩き直さない。
 *
 * **一度`all`まで広げた母集団は狭めない。** `open`は`all`の部分集合なので、PRペインを離れて
 * 要求が`open`へ戻るたびに取り直すと、ペインを出入りするだけでGitHub APIを消費してしまう（#1389）。
 *
 * **ダッシュボードを開いている間は常に有効。** 左メニューの件数表示（#1389）のため、PRペインを
 * 開いていなくてもマウント時に1回だけ取得する。
 *
 * **自動更新は`autoRefreshIntervalMs`が渡されている間だけ**（#1531・#1767。呼び出し側で
 * 「完了したPR」ビューの表示中（10秒）と、ブランチ画面でユーザーが間隔を選んだ場合に
 * 限っている）。1回の取得で「リポジトリ数 + draft以外のopen PR数」ぶんGitHub APIを呼ぶため
 * （[/api/pull-requests](../app/api/pull-requests/route.ts)）、常時ポーリングするとインストール
 * 当たりの上限（5,000回/時）を超える。10秒間隔で回せるのは、取得側がETagの条件付きGETを
 * 通していて変化が無い間は304＝レート制限を消費しないため
 * （[lib/github/conditional-request.ts](../lib/github/conditional-request.ts)）。
 */
export function usePullRequests(
  scope: PullRequestListScope,
  autoRefreshIntervalMs: AutoRefreshIntervalMs = null,
): UsePullRequestsResult {
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [failedRepositories, setFailedRepositories] = useState<string[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<PullRequestListScope | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // refreshで再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);
  // 実際に取得する母集団。要求が狭まっても`all`のまま据え置く（#1389）。effectで追従させると
  // 狭い方の取得が1回走ってから広げ直すことになるため、レンダー中に調整する
  // （Reactの「propsの変化に合わせてstateを調整する」パターン）。
  const [fetchScope, setFetchScope] = useState<PullRequestListScope>(scope);
  if (scope === "all" && fetchScope === "open") setFetchScope("all");

  // 自動更新から呼ぶ取得処理。取得effectの中で作った関数をここへ預け、ポーリングのeffectが
  // 取得effectを再実行させずに（＝`isLoading`を立て直さずに）呼べるようにする。
  const backgroundLoadRef = useRef<(() => Promise<void>) | null>(null);
  // ユーザーの操作（引っ張って更新）から呼ぶ取得処理。失敗を`error`へ出す点だけが違う（#1947）
  const pullLoadRef = useRef<(() => Promise<void>) | null>(null);
  /**
   * 飛んでいる取得。**真偽値ではなくPromiseで持つ**（#1947）。
   *
   * 遅い応答が重なるとGitHub APIを無駄に消費するので次を投げないのは従来どおりだが、
   * 引っ張って更新は「いま飛んでいる取得の完了」を待てないと空振りになる。
   */
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);
  const refreshInBackground = useCallback(() => void backgroundLoadRef.current?.(), []);
  const refreshFromPull = useCallback(
    () => pullLoadRef.current?.() ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    /**
     * 取得のきっかけ（#1531・#1947）。読み込み表示（`isLoading`＝「読み込み中...」）を出すのは
     * 画面を開いた・母集団が変わったときだけで、10秒ごとに点滅させない。失敗を`error`へ出すのは
     * 「ユーザーがそれを待っている」ときだけで、自動更新の瞬断は次の周期で回復するため黙る。
     *
     * | kind | isLoading | 失敗を画面に出す |
     * | --- | --- | --- |
     * | `initial` | 出す | 出す |
     * | `background`（自動更新・通知ベル） | 出さない | 出さない |
     * | `pull`（引っ張って更新） | 出さない | 出す |
     */
    async function runLoad(kind: "initial" | "background" | "pull") {
      // 更新アイコンの回転は自動更新でも出す（#1767）
      setIsRefreshing(true);
      if (kind === "initial") {
        setIsLoading(true);
        setError(null);
      }
      try {
        const res = await fetch(`/api/pull-requests?scope=${fetchScope}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `リクエストに失敗しました (${res.status})`,
          );
        }
        const data: PullRequestListResponse = await res.json();
        if (cancelled) return;
        setPullRequests(data.pullRequests);
        setFailedRepositories(data.failedRepositories);
        setFetchedAt(data.fetchedAt);
        // 実際に取れた母集団を残す。要求した`scope`ではなく「手元にある結果が何か」を返す（#1711）
        setLoadedScope(fetchScope);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (cancelled || kind === "background") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
          if (kind === "initial") setIsLoading(false);
        }
      }
    }

    /**
     * 取得の入口。**飛んでいる取得があれば、それの完了を待って返す**（#1947）。
     * 投げ直さないのは従来どおり（重なるとGitHub APIを無駄に消費する）だが、
     * 待てるようにしないと引っ張って更新が空振りになる。
     */
    function load(kind: "initial" | "background" | "pull"): Promise<void> {
      const inFlight = inFlightRef.current;
      if (inFlight) return inFlight;
      const started = runLoad(kind).finally(() => {
        inFlightRef.current = null;
      });
      inFlightRef.current = started;
      return started;
    }

    backgroundLoadRef.current = () => load("background");
    pullLoadRef.current = () => load("pull");
    void load("initial");

    return () => {
      cancelled = true;
      controller.abort();
      backgroundLoadRef.current = null;
      pullLoadRef.current = null;
      // **effectを張り直すときは飛んでいる取得の記録も捨てる。** 残すと、`refresh`で
      // 母集団を取り直したいのに、中断済みの取得を待って何も取らずに返ってしまう。
      inFlightRef.current = null;
    };
  }, [fetchScope, reloadKey]);

  // 裏に回っているタブでは取りに行かない・有効になった直後に1回取る、といった扱いは
  // ブランチ状況（`use-branch-flow.ts`）と共通なので`useAutoRefresh`が持つ（#1767）。
  useAutoRefresh(autoRefreshIntervalMs, backgroundLoadRef);

  return {
    pullRequests,
    failedRepositories,
    fetchedAt,
    loadedScope,
    isLoading,
    isRefreshing,
    error,
    refresh,
    refreshInBackground,
    refreshFromPull,
  };
}
