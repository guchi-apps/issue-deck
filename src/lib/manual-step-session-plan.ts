import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { buildManualStepRunPlan, type ManualStepRunEntry } from "@/lib/manual-step-autorun";
import { parseManualStepGuide } from "@/lib/manual-step-guide";

/**
 * 手作業セッション（#2771）が**聞かずに流す手順**と、**人に頼む手順**の内訳（#2830）。
 *
 * セッションはこれまで手順ごとに「実行しますか？」「次へ進みますか？」と2回ずつ聞いていた。
 * 本文に書かれたコマンドは「セッションを起動」を押した1回で承認済みとして流す形へ変えるにあたり、
 * **押す前に何が実行されるのかを画面へ出す**（手作業アシスタントの承認パネルと同じ立場。#1869）。
 *
 * **判定は`buildManualStepRunPlan`をそのまま通す。** 「どの手順を人に頼むか」の条件
 * （端末・`<…>`・対話が要るコマンド・コマンドが1つに定まらない）は代行実行と同じで、
 * ここに書き足すと画面の一覧とセッションの振る舞いがずれる。
 */

export type ManualStepSessionPlan = {
  /** 実行する順の並び（手順1..n → 完了の確認）。チェック済みの手順も含む */
  entries: ManualStepRunEntry[];
  /** セッションが聞かずに流す件数（未チェックかつ本文のコマンドを実行できるもの） */
  auto: number;
  /** 人に頼む件数（未チェックで、セッションが代行しないもの） */
  user: number;
};

/**
 * セッションが「代行実行できるホスト」として振る舞う前提の申告（#2830）。
 *
 * 代行実行（`MANUAL_STEP`）の可否はpollerの申告（`manualStepCapable`・オンラインか）に
 * 左右されるが、**セッションはそのジョブを使わず自分の`Bash`で実行する**——起動できるかどうかは
 * `resolveManualStepSessionRejection`（`manualStepSessionCapable`）が別に見ている。
 * ここでホストの申告を理由に「人に頼む」へ倒すと、起動できるのに全件が「あなたが実行」になる。
 *
 * **`resolveManualStepExecutionRejection`はIssueと手順の性質を先に見てからホストを見る**ので、
 * ホストを満たした状態で通せば、残るのは手順の性質だけになる。
 */
const SESSION_HOST: Pick<
  DispatchHostView,
  "online" | "manualStepCapable" | "manualStepValuesCapable"
> = {
  online: true,
  manualStepCapable: true,
  manualStepValuesCapable: true,
};

export function buildManualStepSessionPlan(
  body: string | null,
  options: { isManualStepIssue: boolean },
): ManualStepSessionPlan {
  const plan = buildManualStepRunPlan(body, parseManualStepGuide(body), {
    host: SESSION_HOST,
    isManualStepIssue: options.isManualStepIssue,
    // **押す前の一覧なので、積まれているジョブの有無は見ない。** `hasActiveJob`は代行実行の
    // 二重投入を止めるためのもので、セッションの起動可否は`ManualStepSessionPanel`が別に見る
    hasActiveJob: false,
  });

  return { entries: plan.entries, auto: plan.runnable, user: plan.blocked };
}
