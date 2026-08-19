import { CHECK_USER_LABEL, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
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

/**
 * 起動する実行の種類。
 *
 * `plan`・`implement`は`reusable-issue-dispatch.yml`のmodeにそのまま対応する。
 * `approve-plan`は「提示済みの計画を承認して実装へ進める」操作で、ワークフロー側に対応する
 * modeは無い。**承認はラベルを外すことで表現される**（`00.check-user`・`21.plan-required`が
 * 両方外れた状態がワークフローにとっての「承認済み」）ため、issue-deck側でラベルを片付けてから
 * コメントを投稿すると、ワークフローは通常の実装（またはサブIssue分割）として動く。
 */
export type DispatchMode = "plan" | "implement" | "approve-plan";

/**
 * ローカル（VS Code等）のClaude Codeセッションで対応中であることを人間が明示するラベル（#919）。
 * 付いている間は`reusable-issue-dispatch.yml`が無人実行を起動しないため、こちらも起動しない。
 */
export const LOCAL_LABEL_NAME = "11.local";

/**
 * `11.local`（と`additional`で渡したラベル）を足したラベル名の配列を返す。
 * **足すものが1つも無ければ`null`**（更新不要）。
 *
 * 画面からサブPCへ起動する経路が2つ（「サブPCで開始」ボタンと、スマホの「実装を開始」
 * ダイアログでの実行先選択・#1248）になったため、判定をここに1つだけ置く。
 *
 * `additional`は「まとめて実行」で選んだオプションのラベル（#1993）。**`11.local`と同じ
 * 1回の書き込みで付ける** — Issueの件数ぶん繰り返す経路なので、GitHubへの往復を倍にしない。
 */
export function labelNamesWithLocal(
  labels: readonly { name: string }[],
  additional: readonly string[] = [],
): string[] | null {
  const names = labels.map((label) => label.name);
  const toAdd = [...new Set([...additional, LOCAL_LABEL_NAME])].filter(
    (name) => !names.includes(name),
  );
  if (toAdd.length === 0) return null;
  return [...names, ...toAdd];
}

/**
 * そのIssueが**ローカル（サブPCまたは手元）で対応中か**（`11.local`が付いているか）。
 *
 * 起動の経路によらず、**画面から起動したときは積むより先にこのラベルを付ける**
 * （`start-local-session-button.tsx`の`ensureLocalLabel`・「実装を開始」ダイアログも同じ）。
 * サブPCのランチャー（`start-issue.sh`）も起動時に付けるため、**ジョブ・セッションの記録が
 * まだ画面へ届いていない間、実行が始まったことを知っている唯一の材料**になる（#1815）。
 */
export function isLocalSessionIssue(labels: readonly { name: string }[]): boolean {
  return labels.some((label) => label.name === LOCAL_LABEL_NAME);
}

/** 未着手を表すProject Status名 */
const READY_STATUS = getProgressStatusDef("ready").projectStatus;

/**
 * Statusの遷移から起動する実行を判定する。起動しないならnull。
 *
 * 対象にするのは次の3つだけ。
 *
 * | 遷移 | 条件 | 結果 |
 * |---|---|---|
 * | `Ready` → `Planning` | — | `plan` |
 * | `Ready` → `Implementation` | — | `implement` |
 * | `Planning` → `Implementation` | 計画の承認待ち | `approve-plan` |
 *
 * **途中の段階からの移動を無条件には拾わない。** 拾うと進捗の巻き戻しや報告APIの書き込みが
 * 実行の再起動になってしまう。**後戻りにも何も割り当てない。** 実行のキャンセルを割り当てると
 * Statusを書き戻す処理と往復しうるうえ、ドラッグの誤操作で実行が止まる影響が大きい。
 *
 * `from`が`null`（Projectへ追加された直後でStatus未設定・DBに履歴が無い）も対象外にする。
 * 盤面へ載せた操作そのものが実行の開始になってしまうため。
 */
export function resolveDispatchMode(params: {
  from: string | null;
  to: string | null;
  /** 対象Issueに付いているラベル名。承認待ちかどうかの判定に使う */
  labels: string[];
}): DispatchMode | null {
  const { from, to, labels } = params;
  if (!to) return null;
  const toKey = matchProjectStatus(to);

  if (from === READY_STATUS) {
    if (toKey === "planning") return "plan";
    if (toKey === "implementation") return "implement";
    return null;
  }

  // 計画の承認。**承認待ちであることを確認してから**でないと、計画の実行中にカードを動かした
  // だけで実装が始まってしまう。`21.plan-required`が付いている間は「質問への回答のみの確認待ち」
  // ではなく計画そのものへの承認待ちであることがapproval-labels.tsの判定で保証されている
  if (from === getProgressStatusDef("planning").projectStatus && toKey === "implementation") {
    const names = new Set(labels);
    return names.has(CHECK_USER_LABEL) && names.has(PLAN_REQUIRED_LABEL) ? "approve-plan" : null;
  }

  return null;
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
const INSTRUCTIONS: Record<DispatchMode, string> = {
  plan: "@claude 計画を立案してください",
  implement: "@claude 実装を開始してください",
  // 「計画を承認」ボタンの定型文（approval-labels.tsのapproveCommentBody）と揃える
  "approve-plan": "@claude 計画を承認しました。実装を進めてください。",
};

export function dispatchCommentBody(params: {
  mode: DispatchMode;
  /** Statusを動かした人のログイン名。この人のwrite権限がワークフロー側で検証される */
  senderLogin: string;
  /** カンバン上の遷移先Status名。何が起点で始まったかをIssue上に残す */
  toStatus: string;
}): string {
  return [
    INSTRUCTIONS[params.mode],
    "",
    `（GitHub ProjectsでStatusを\`${params.toStatus}\`へ変更したため開始します）`,
    "",
    "<!-- issue-deck-source:project-status-dispatch -->",
    "",
    posterMarker(params.senderLogin),
  ].join("\n");
}
