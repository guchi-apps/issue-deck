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
   * `11.local`を外して無人実行へ渡す。札を外してからコメントを投稿するので、
   * `issue_comment`を受けた時点でワークフローはもうスキップしない。
   */
  | {
      kind: "handoff";
      /** 担当していたホスト名。セッションの記録が無ければ`null` */
      host: string | null;
      /** セッションの記録があり、それが終わっているか（`false`は「記録が無い」） */
      sessionEnded: boolean;
    };

/**
 * セッションへ流す固定の1行（#2919）。
 *
 * **本文を実行体が組み立てない。** `docs/multi-agent/gates.md`の線は「固定文面の送信は可、
 * 選択肢の確定は不可」で、停滞からの復旧（`session-stall.ts`）と同じ立場にある。人が書いた
 * 修正依頼はIssueコメントの側に入り、ここを通るのは常にこの1行だけ。
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
 * **`ALIVE`以外はすべて引き継ぎ側へ倒す。** セッションの記録は24時間で落ちるため、
 * 「終了した」と「記録がもう無い」は画面からは見分けられない——どちらも「送る相手がいない」
 * ことに変わりはないので、行き先は同じにして文面だけ言い分ける（`sessionEnded`）。
 */
export function resolvePrFixRequestRoute(params: {
  labels: readonly { name: string }[];
  session: Pick<DispatchSessionView, "host" | "state"> | null;
}): PrFixRequestRoute {
  if (!isLocalSessionIssue(params.labels)) return { kind: "actions" };
  const session = params.session;
  if (session && session.state === "ALIVE") return { kind: "session", host: session.host };
  return { kind: "handoff", host: session?.host ?? null, sessionEnded: session !== null };
}

/**
 * 送り先ごとのボタンの文言。
 *
 * **「修正を依頼する」のままにしない。** 押したときに起きることが3通りに分かれるので、
 * 何が起きるのかをボタン自身に言わせる（引き継ぎでは`11.local`を外すところまで書く——
 * ラベルが黙って外れると、無人実行が動き出した理由が後から読めなくなる）。
 */
export function prFixRequestActionLabel(route: PrFixRequestRoute): string {
  switch (route.kind) {
    case "actions":
      return "修正を依頼する";
    case "session":
      return "セッションへ送る";
    case "handoff":
      return `${LOCAL_LABEL_NAME}を外して依頼する`;
  }
}

/**
 * 修正依頼の投稿と一緒に更新するラベル名の配列。
 *
 * 土台は他の操作と揃えて`labelsAfterRejection`（`00.check-user`と理由ラベルだけを外し、
 * `21.plan-required`は残す）。引き継ぎのときだけ`11.local`も落とす。
 *
 * **落とすのはコメントより先**（呼び出し側の`updateLabelsAndComment`がラベル→コメントの順で
 * 送る）。逆にすると、コメントを受けたワークフローがまだ札の付いた状態を読み、スキップの
 * 案内コメントを返して終わる。
 */
export function prFixRequestLabels(route: PrFixRequestRoute, labels: IssueLabel[]): string[] {
  const next = labelsAfterRejection(labels);
  if (route.kind !== "handoff") return next;
  return next.filter((name) => name !== LOCAL_LABEL_NAME);
}
