import {
  resolveIssueImplementationAgent,
  type IssueImplementationAgent,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { labelsAfterRejection } from "@/lib/github/approval-labels";
import { isLocalSessionIssue, LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import type { IssueLabel } from "@/types/issue";

/**
 * マージ待ちの「修正を依頼する」を、**そのIssueを今どこが担当しているか**で振り分ける（#2919）。
 *
 * 元の作りは1通りしか無かった。`00.check-user`を外して`@claude …`のコメントを投稿し、
 * `issue_comment`で起きた`reusable-issue-dispatch.yml`が既存PRへ追加コミットする（#376）。
 *
 * **`11.local`が付いている間、その経路は動かない。** ワークフローは読み取り専用の質問応答
 * （`mode=ask`）を除いてすべて`mode=skip`へ倒し（`reusable-issue-dispatch.yml`）、
 * 「`11.local`を外してから、改めて`@claude`とコメントしてください」という案内コメントを1件
 * 返して終わる。押した人から見ると、修正依頼を書いて送ったのにコメントが2件増えただけになる。
 *
 * そこで送り先を先に決め、**ボタンの文言と、押したときに起きることをその送り先に合わせる**。
 *
 * **判定材料は`11.local`ラベルそのもの**で、`resolveIssueExecutionTarget`の
 * `expectsActionsRun`は使わない。あちらはセッション・ジョブの記録（24時間残る）も見るため、
 * **ラベルを外して無人実行へ引き継いだ直後のIssueでも`false`になる**——そこは今まさに
 * Actionsが拾う状態で、引き継ぎをもう一度やらせても意味が無い。ここで知りたいのは
 * 「ワークフローが自分を止めるか」の1点だけなので、ワークフローが見ているものと同じものを見る。
 */
export type PrFixRequestRoute =
  /** 無人実行（GitHub Actions）が拾う。従来どおり`@claude …`のコメントを投稿するだけ */
  | { kind: "actions" }
  /**
   * 走っているローカルセッションへ知らせる。コメントを記録として残したうえで、
   * そのセッションへ`INSTRUCTION`ジョブで固定の1行を流す。
   */
  | { kind: "session"; host: string }
  /**
   * 終了したセッションを呼び戻して依頼する（#2919のG1レビュー）。
   *
   * **`11.local`を外して無人実行へ倒さない。** Issueの要求が「クローズしていたら再度立ち上げる」で、
   * 呼び戻す導線は#1830で既にある——worktreeを消していなければランチャーが`claude --continue`を
   * 渡し、前回の会話の続きから再開する（`describeSessionRecovery`）。**起動のたびに
   * `.prompts/issue-<番号>.md`は作り直される**ので、直前に投稿した修正依頼のコメントも
   * そのプロンプトへ載る（`scripts/start-issue.sh`）。
   *
   * **`agent`を持つのは、呼び戻す相手のCLIを取り違えないため。** 起動ジョブの`agent`を省くと
   * 受け口が既定（`claude`）へ落とすので、Codexで進んでいたIssueが黙ってClaude Codeで立ち上がる
   * （「前回の会話の続きから再開します」という案内が嘘になる）。判定は既存の「セッションを復旧」
   * （`SessionRecoveryButton`）と同じ`resolveIssueImplementationAgent`。
   */
  | { kind: "resume"; host: string; agent: IssueImplementationAgent }
  /**
   * `11.local`を外して無人実行へ渡す。**セッションの記録すら無いときの最終手段。**
   * 記録は24時間で消えるので、それより後に押されたときはホストも特定できず、呼び戻す先が無い。
   */
  | { kind: "handoff" };

/**
 * セッションへ流す固定の1行（#2919）。
 *
 * **本文を実行体が組み立てない。** `docs/multi-agent/gates.md`の線は「固定文面の送信は可、
 * 選択肢の確定は不可」で、停滞からの復旧（`session-stall.ts`）と同じ立場にある。人が書いた
 * 修正依頼はIssueコメントの側に入り、ここを通るのは常にこの1行だけ。
 * **受け口（`POST /api/dispatch/pr-fix-notify`）が、届いた本文がこれと同じかを確かめ直す。**
 *
 * 依頼の本文そのものを流さないのは、`DispatchJob.instruction`が**改行を含まない1行**しか
 * 受けないため（複数行は確定キーの解釈が画面の実装に依存する）。長い指示はコメントに書き、
 * ここへは読みに行かせる1行を流す、というのが元からの使い方。
 */
export const PR_FIX_SESSION_INSTRUCTION =
  "Issueに修正依頼のコメントを追加しました。読んで対応してください。";

/**
 * 送り先を決める。
 *
 * `session`に渡すのは`findSessionForIssue`の結果（生きているものを優先して1件返す）。
 * **`ALIVE`以外でも記録が残っている間は呼び戻す側へ倒す**（`resume`）。記録が消えて
 * ホストすら特定できないときだけ、`11.local`を外す`handoff`になる。
 */
export function resolvePrFixRequestRoute(params: {
  labels: readonly { name: string }[];
  session: Pick<DispatchSessionView, "host" | "state" | "codexThreadKnown"> | null;
}): PrFixRequestRoute {
  if (!isLocalSessionIssue(params.labels)) return { kind: "actions" };
  const session = params.session;
  if (!session) return { kind: "handoff" };
  if (session.state === "ALIVE") return { kind: "session", host: session.host };
  // **呼び戻すCLIはここで決める。** 画面側で決めると、PC・スマホの2か所へ同じ解決を書くことになり、
  // 片方だけ書き忘れると「Codexのつもりが黙ってClaude Codeで立つ」が戻る
  return { kind: "resume", host: session.host, agent: resolveIssueImplementationAgent(session) };
}

/**
 * 送り先ごとのボタンの文言。
 *
 * **「修正を依頼する」のままにしない。** 押したときに起きることが4通りに分かれるので、
 * 何が起きるのかをボタン自身に言わせる（引き継ぎでは`11.local`を外すところまで書く——
 * ラベルが黙って外れると、無人実行が動き出した理由が後から読めなくなる）。
 */
export function prFixRequestActionLabel(route: PrFixRequestRoute): string {
  switch (route.kind) {
    case "actions":
      return "修正を依頼する";
    case "session":
      return "セッションへ送る";
    case "resume":
      return "セッションを再開して依頼する";
    case "handoff":
      return `${LOCAL_LABEL_NAME}を外して依頼する`;
  }
}

/**
 * 修正依頼の投稿と一緒に更新するラベル名の配列。**`null`は「ラベルを変えない」。**
 *
 * - 無人実行・引き継ぎ: 他の操作と揃えて`labelsAfterRejection`（`00.check-user`と理由ラベル
 *   だけを外し、`21.plan-required`は残す）。引き継ぎではさらに`11.local`も落とす。
 *   **落とすのはコメントより先**（呼び出し側の`updateLabelsAndComment`がラベル→コメントの順で
 *   送る）。逆にすると、コメントを受けたワークフローがまだ札の付いた状態を読み、スキップの
 *   案内コメントを返して終わる
 * - セッション・再開: **`00.check-user`をここでは外さない**（#2919のG1レビュー）。
 *   `INSTRUCTION`の送出は非同期で、承認プロンプトの表示中・作業中・入力欄に打ちかけがある
 *   場合はpollerが見送る。積んだ時点で外すと**何も届いていないのに札だけ消える**
 *   （#2886で同じ指摘を受けた停滞からの復旧と同じ扱い）。外れるのは`succeeded`の報告が
 *   届いた時点（`POST /api/dispatch/report`）。再開は既存の「セッションを復旧」に揃えて、
 *   そちらもラベルを触らない
 */
export function prFixRequestLabels(
  route: PrFixRequestRoute,
  labels: IssueLabel[],
): string[] | null {
  switch (route.kind) {
    case "actions":
      return labelsAfterRejection(labels);
    case "handoff":
      return labelsAfterRejection(labels).filter((name) => name !== LOCAL_LABEL_NAME);
    case "session":
    case "resume":
      return null;
  }
}
