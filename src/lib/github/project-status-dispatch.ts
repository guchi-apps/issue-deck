import {
  getProgressStatusDef,
  matchProjectStatus,
  type ProgressStatusKey,
} from "@/lib/issue-progress";

/**
 * Project Statusの変化から実行を起動するかどうかの判定（#991 Phase 3）。
 *
 * **ボタンとカンバンのドラッグで判定を共通化するための1箇所。** 起動経路は2つあるが、
 * 「起動するか」「計画なのか実装なのか」の条件はここだけにある。
 *
 * - **ボタン**: サーバー側でオプションラベル→Status→`@claude`コメントを順に書く。
 *   コメントの投稿者は操作した人間のままで、`reusable-issue-dispatch.yml`の権限検証
 *   （`github.actor`のwrite権限確認）をそのまま通る
 * - **ドラッグ**: `projects_v2_item` Webhookを受けてissue-deckが`@claude`コメントを投稿する。
 *   投稿者はissue-deckのGitHub Appになるため、`<!-- issue-deck:posted-by:<login> -->`で
 *   実際に操作した人間へ読み替えさせる
 *
 * 設計の一次情報源は docs/progress-status-architecture.md。
 */

/** 起動する実行の種類。`reusable-issue-dispatch.yml`のmode（plan/implement）に対応する */
export type DispatchMode = "plan" | "implement";

/**
 * ローカル（VS Code等）のClaude Codeセッションで対応中であることを人間が明示するラベル（#919）。
 * 付いている間は`reusable-issue-dispatch.yml`が無人実行を起動しないため、こちらも起動しない。
 */
export const LOCAL_LABEL_NAME = "11.local";

/** 未着手を表すProject Status名。ここからの遷移だけを起動対象にする */
const READY_STATUS = getProgressStatusDef("ready").projectStatus;

/**
 * Statusの遷移から起動する実行を判定する。起動しないならnull。
 *
 * **`Ready`からの遷移だけを対象にする。** 途中の段階からの移動（例: `Develop` → `Implementation`）を
 * 拾うと、進捗の巻き戻しや報告APIの書き込みが実行の再起動になってしまう。
 * **後戻り（`Implementation` → `Ready`等）にも何も割り当てない。** 実行のキャンセルを割り当てると
 * Statusを書き戻す処理と往復しうるうえ、ドラッグの誤操作で実行が止まる影響が大きい。
 *
 * `from`が`null`（Projectへ追加された直後でStatus未設定・DBに履歴が無い）も対象外にする。
 * 盤面へ載せた操作そのものが実行の開始になってしまうため。
 */
export function resolveDispatchMode(from: string | null, to: string | null): DispatchMode | null {
  if (from !== READY_STATUS || !to) return null;

  switch (matchProjectStatus(to)) {
    case "planning":
      return "plan";
    case "implementation":
      return "implement";
    default:
      return null;
  }
}

/**
 * このStatus変更がissue-deck自身のGitHub Appによるものかどうか。
 *
 * **trueなら起動しない。** Phase 2でProjectを書くのがissue-deck自身になったため、
 * これが無いと「Actionsが`implementation`を報告する」→「Webhookで実装が再起動する」という
 * 自己ループが起きる。ボタン経由の書き込みもここで止まるが、ボタンは自分でコメントを
 * 投稿するため取りこぼしにはならない（判定は同じ`resolveDispatchMode`を通る）。
 */
export function isOwnAppSender(login: string | undefined): boolean {
  if (!login) return false;
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  return Boolean(slug) && login === `${slug}[bot]`;
}

/**
 * 起動によってのみ到達する段階かどうか。
 *
 * この段階にいるのにGitHub Actionsの実行が1つも紐づいていなければ「起動待ち」とみなせる。
 * `develop-pr`以降は起動ではなくPRのイベントで進むため、実行が無くても異常ではない。
 */
export function isDispatchedStatusKey(key: ProgressStatusKey): boolean {
  return key === "planning" || key === "implementation";
}

/** `reusable-issue-dispatch.yml`が投稿者マーカーから人間のログイン名を復元するためのマーカー */
export function posterMarker(login: string): string {
  return `<!-- issue-deck:posted-by:${login} -->`;
}

/**
 * ドラッグ起点で投稿する`@claude`コメントの本文を組み立てる。
 *
 * 投稿者マーカーは**必ず末尾**に置く。ワークフロー側が`grep -oP ... | tail -n1`で読むため、
 * 本文中に偽のマーカーが混ざっても最後のものが優先される（`reusable-issue-dispatch.yml`の
 * 「Bot判定・実行者パーミッション確認」ステップ参照）。
 */
export function dispatchCommentBody(params: {
  mode: DispatchMode;
  /** Statusを動かした人のログイン名。この人のwrite権限がワークフロー側で検証される */
  senderLogin: string;
  /** カンバン上の遷移先Status名。何が起点で始まったかをIssue上に残す */
  toStatus: string;
}): string {
  const instruction =
    params.mode === "plan" ? "@claude 計画を立案してください" : "@claude 実装を開始してください";
  return [
    instruction,
    "",
    `（GitHub ProjectsでStatusを\`${params.toStatus}\`へ変更したため開始します）`,
    "",
    "<!-- issue-deck-source:project-status-dispatch -->",
    "",
    posterMarker(params.senderLogin),
  ].join("\n");
}
