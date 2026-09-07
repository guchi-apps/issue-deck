import type {
  DispatchSessionView,
  SessionInterruptedReason,
} from "@/lib/dispatch/session-state";

/**
 * 停滞したセッションを画面から復旧させるための判定と文面（#2886）。
 *
 * **DBにもGitHubにも触らない純粋関数だけを置く**（`issue-session.ts`と同じ立場）。呼ぶのは
 * Issue詳細の停滞パネル（`session-stall-panel.tsx`）と、押されたときの受け口
 * （`POST /api/dispatch/session-recovery`）の両方で、**送ってよい文面かどうかを2か所で
 * 同じ関数から引く**（画面だけ緩いと、押せたのに400で弾かれる）。
 *
 * ## なぜ画面から送れるようにするのか
 *
 * `supervisor:session-interrupted`の引き上げ（#1971・#2655・#2844）は、Issueコメントと
 * `00.check-user`にしか残っていなかった。復旧の文面はコメント本文のコードブロックとして
 * 書かれているだけで、送るには`tmux attach`かRemote Control（Claude Codeアプリ）を人が開く
 * 必要があった（guchi-apps/research-desk#118）。
 *
 * ## `docs/multi-agent/gates.md`との関係
 *
 * 送るのは**このファイルが持つ固定文面**で、状況を読んで組み立てる実行体はどこにも無い。
 * 押すのは人で、送出は既存の追加指示（#1012）の3段階プロトコルをそのまま通る——つまり
 * 承認プロンプト・選択フォームの表示中は従来どおり見送られる。gates.mdの例外2（追加指示）の
 * 「本文を組み立てるのは人」「画面の定型文も、差し込むだけで押すのは人」と同じ線の内側で、
 * **違うのは定型文が原因ごとに決まっていることだけ**。答えを選ばせる操作（選択肢の確定）は
 * 引き続き画面から行わない。
 */

/** 復旧の押しボタン1つぶん。`body`はそのまま追加指示として送られる固定文面 */
export type SessionStallRecoveryPreset = {
  /** ボタンの文言。**何が起きるか**を書く（「送信」のような操作名にしない） */
  label: string;
  /** 送る本文。**改行を含まない1行**（`parseSessionInstruction`が通る形） */
  body: string;
};

/** 停滞パネルに出す内容。停滞していなければ`describeSessionStall`が`null`を返す */
export type SessionStallNotice = {
  reason: SessionInterruptedReason;
  /** 何が起きたか（パネルの見出し） */
  title: string;
  /** なぜ止まっているか・何をすると解けるか（1段落ずつ） */
  detail: string[];
  /**
   * 押せる固定文面。**空にはならない**——押す相手が無いパネルは、Issueコメントを読むのと
   * 変わらない。`classifier_blocked`のように「これを送れば直る」文面が無い原因でも、
   * 人が選べる続け方を並べる
   */
  presets: SessionStallRecoveryPreset[];
};

/**
 * APIエラーで中断したときの復旧文面。**pollerが自動再開で送るものと同じ1行**
 * （`scripts/lib/session-resume.sh`の`SESSION_RESUME_BODY`）。
 *
 * 引き上げが出ている時点でpollerは上限回数（既定3回）まで送り終えているが、**送れなかった
 * （承認プロンプトの表示中など）まま上限に達している場合がある**ので、人が押して送り直せる
 * ことに意味がある。
 */
const API_ERROR_BODY = "直前の応答がAPIエラーで中断しました。中断したところから作業を続けてください。";

/**
 * ツールを呼んだつもりで呼んでいないときの復旧文面。**引き上げコメントに載せているものと
 * 同じ文面を1行に畳んだもの**（`buildSessionInterruptedCommentBody`）。
 *
 * 「進めて」のような曖昧な継続指示だと、モデルが直前の自分の発言を「既にツールを呼び出した」
 * という事実だと誤認したまま再び止まる（#2655）。**呼ばれていないことを事実として明言する**
 * のがこの文面の要点なので、短く言い換えない。
 */
const TOOL_CALL_STALL_BODY =
  "直前の応答はツール呼び出し風のテキストを出力しただけで、実際にはツールは呼ばれていません。バックグラウンドで動いているものは何もありません。もう一度、実際にツールを呼び出して進めてください。";

/**
 * 原因ごとの文面（#2886）。**ここだけが文面の正**で、画面もAPIもここから引く。
 *
 * `classifier_blocked`に「これを送れば直る」文面が無いのは、拒否そのものが妥当な挙動だから
 * （#2844）。同じコマンドを促す文面を置くと、もう一度拒否されて終わる。並べるのは**人が選ぶ
 * 続け方**——別の手段へ振るか、人が代わりに実行すると伝えるかの2つで、どちらを送るかを
 * 決めるのは押す人。
 */
const STALL_NOTICES: Record<SessionInterruptedReason, SessionStallNotice> = {
  api_error: {
    reason: "api_error",
    title: "APIエラーで中断したまま止まっています",
    detail: [
      "Claude CodeがAPIの一時エラー（529 Overloaded など）を再試行しきるとturnが打ち切られ、`Stop`フックが飛ばないままセッションが入力欄で止まります。",
      "サブPCのpollerが固定の1行を上限回数まで送りましたが、復帰しませんでした。同じ1行をここから送り直せます。",
    ],
    presets: [{ label: "中断したところから続けるよう送る", body: API_ERROR_BODY }],
  },
  tool_call_stall: {
    reason: "tool_call_stall",
    title: "ツールを呼び出さないまま応答を終えています",
    detail: [
      "ツール（`Agent`など）を呼び出すつもりで、実際にはtool_useとして呼び出さずコード風のテキストを出力するだけでターンを終えた可能性があります。`Stop`は正常に発火するため、画面からは「正常に応答した」ようにしか見えません。",
      "「進めて」のような曖昧な継続指示では解けません（直前の自分の発言を「既に呼び出した」と誤認したまま再び止まります）。呼ばれていないことを事実として伝える文面を送ります。",
    ],
    presets: [
      { label: "ツールが呼ばれていないと伝えて送る", body: TOOL_CALL_STALL_BODY },
    ],
  },
  classifier_blocked: {
    reason: "classifier_blocked",
    title: "コマンドが拒否されたまま応答を終えています",
    detail: [
      "`--permission-mode auto`のクラシファイアは、承認プロンプトを出さずにコマンドを拒否することがあります。このとき`Notification`フックは飛ばず、`Stop`だけが正常に発火するため、画面からは「正常に応答した」ようにしか見えません。",
      "**「進めて」だけでは解除されません**（同じコマンドがもう一度拒否されるだけです）。別の手段へ振るか、拒否されたコマンドを人が代わりに実行してください。",
    ],
    presets: [
      {
        label: "別の手段で進めるよう送る",
        body: "拒否されたコマンドは実行せず、別の手段で進めてください。別の手段が無ければ、何を実行したいのかをIssueコメントに書いて止まってください。",
      },
      {
        label: "人が代わりに実行すると送る",
        body: "拒否されたコマンドは私が代わりに実行します。実行してほしいコマンドの全文をIssueコメントに書いて待っていてください。",
      },
    ],
  },
};

/**
 * そのセッションが**今も**停滞しているか（#2886）。停滞していなければ`null`。
 *
 * 条件は2つ。
 *
 * - **生きているセッションに限る。** 終わった行の出口は「セッションを復旧」
 *   （`SessionRecoveryButton`）で、そちらは起動ジョブを積み直す別の操作
 * - **引き上げ以降にフックの報告が無いこと。** セッションが動き出せば`activityAt`（`Stop`・
 *   承認待ち）か`stepSeenAt`（ツールの実行）が`interruptedAt`を追い越す。**解除の受け口を
 *   別に作らないのは、それが飛ばなかったときに「復旧済みなのに停滞パネルが出たまま」が
 *   残るから**で、追い越しで判定すれば取りこぼしても次のフックで自然に消える
 *
 * `interruptedAt`と同時刻の報告は「まだ停滞している」側に倒す。引き上げの直前に発火した
 * `Stop`（`tool_call_stall`・`classifier_blocked`はその形）を「動き出した」と読むと、
 * パネルが一度も出ない。
 */
export function describeSessionStall(session: DispatchSessionView): SessionStallNotice | null {
  if (session.state !== "ALIVE") return null;
  if (session.interruptedReason === null || session.interruptedAt === null) return null;

  const interruptedAt = Date.parse(session.interruptedAt);
  if (Number.isNaN(interruptedAt)) return null;

  const movedAt = [session.activityAt, session.stepSeenAt]
    .map((value) => (value === null ? Number.NaN : Date.parse(value)))
    .filter((value) => !Number.isNaN(value));
  if (movedAt.some((value) => value > interruptedAt)) return null;

  return STALL_NOTICES[session.interruptedReason];
}

/**
 * 押された文面が、その原因の固定文面として用意したもののどれかか（#2886）。
 *
 * **受け口（`POST /api/dispatch/session-recovery`）が押された本文を検証するために使う。**
 * 画面が送ってきた文字列をそのまま信じると、この経路が「任意の本文を送れるが確認待ちも
 * 自動で外れる」ものになり、追加指示（#1012）と分けた意味が消える。任意の本文を送りたい
 * ときは従来どおり「追加指示を送る」を使う。
 */
export function isSessionStallRecoveryBody(
  reason: SessionInterruptedReason,
  body: string,
): boolean {
  return STALL_NOTICES[reason].presets.some((preset) => preset.body === body);
}
