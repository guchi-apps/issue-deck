import { CHECK_USER_REASON_HEADING, type CheckUserReason } from "@/lib/github/approval-labels";

/** 画面内で「次の操作」をする場所（`check-user-focus.ts`がDOMのidへ対応付ける） */
export type CheckUserScrollTarget = "approval" | "pull-requests" | "plan" | "question";

/**
 * 次に押すものへの行き先。**`null`は「いま見ている場所が目的地」**（承認カードの中に出す
 * パネルなど）で、その場合は移動ボタンを出さずボタン名だけを添える。
 */
export type CheckUserAction =
  | { kind: "remote-control"; url: string }
  | { kind: "scroll"; target: CheckUserScrollTarget };

/** パネルを出す場所。行き先が自分自身になるかどうかがここで決まる */
export type CheckUserPlacement = "status" | "approval";

export type CheckUserGuidance = {
  reason: CheckUserReason;
  /** 見出し（`CHECK_USER_REASON_HEADING`と同じもの） */
  heading: string;
  /** 何を求めているかの説明 */
  description: string;
  /** **押すボタンの名前を含む1行。** 「承認」「マージ」など画面上の表記をそのまま書く */
  buttons: string;
  action: CheckUserAction | null;
  /**
   * エージェントが待っているのか止まっているのか（docs/multi-agent/labels.mdの表と同じ区分）。
   *
   * **タグの一語だけ**（#2057）。以前は「マージするまで次の工程へ進みません」のような補足文を
   * 添えていたが、どの理由でも`description`か`buttons`が同じことを既に言っており、案内パネルの
   * 4行目が毎回その繰り返しになっていた。
   */
  agentState: string;
};

export type CheckUserImplementationAgent = "claude" | "codex";

type ReasonGuide = {
  description: string;
  /** 移動ボタンを出すとき（目的地が別の場所）の案内 */
  buttonsAway: string;
  /** 目的地に居るときの案内 */
  buttonsHere: string;
  agentState: string;
};

/**
 * 理由ごとの案内文（#1663）。文言は
 * docs/multi-agent/labels.md「理由を表す`01.check-*`ラベル」の表
 * （ユーザーがやること／エージェントの状態）を画面の言葉にしたもの。
 *
 * **ボタン名は画面の表記をそのまま書く。** 「承認」「修正」「取り下げ」「マージ」
 * 「修正を依頼する」は実際のボタンのラベルで、言い換えると押すものが分からなくなる。
 */
const REASON_GUIDE: Record<CheckUserReason, ReasonGuide> = {
  plan: {
    description:
      "エージェントが実装前の計画（アプローチ・変更範囲・懸念点）をコメントに投稿しました。この方針で実装してよいかを判断してください。",
    buttonsAway: "コメント欄の「承認」で実装が始まります。方針を変えるなら「修正」。",
    buttonsHere: "下の「承認」で実装が始まります。方針を変えるなら「修正」。",
    agentState: "待機中",
  },
  input: {
    description:
      "エージェントが自分では決められない点を質問しています。開発環境やスクリーンショットの確認をお願いしている場合もあります。",
    buttonsAway: "コメント欄で回答を書いて「承認」を押すと、内容がエージェントへ渡ります。",
    buttonsHere: "回答を書いて「承認」を押すと、内容がエージェントへ渡ります。",
    agentState: "待機中",
  },
  merge: {
    description:
      "自動マージの条件を満たさなかったため、developへのマージはあなたが行う必要があります。",
    // **「修正を依頼する」は`buttonsHere`にしか書かない**（#2057）。あのボタンはコメント欄の
    // 承認カード（`comment-thread.tsx`）にしか無く、`buttonsAway`の行き先である上部の
    // 対応PRセクションには「マージ」しか置いていない。移動先に無いボタンを案内していた
    buttonsAway: "対応PRの「マージ」を押します。",
    buttonsHere: "下の「マージ」を押します。直したい点があれば「修正を依頼する」。",
    agentState: "待機中",
  },
  blocked: {
    description:
      "エージェントが作業を続けられずに停止しました。理由（依存の追加・行き詰まり・すでに実装済みなど）は直近のコメントにあります。",
    buttonsAway: "コメント欄に続け方を書いて「修正」。対応不要なら「取り下げ」。",
    buttonsHere: "続け方を書いて「修正」。対応不要なら「取り下げ」。",
    agentState: "停止中",
  },
  answered: {
    description: "あなたの質問にエージェントが回答しました。読むだけで、実装は再開しません。",
    buttonsAway: "コメント欄の「承認」を押すと確認待ちが外れます。",
    buttonsHere: "読み終えたら「承認」を押すと確認待ちが外れます。",
    agentState: "待っていません",
  },
};

/**
 * 計画への返事を画面から送れるときの差し替え文（#2061）。
 *
 * **入力待ちの差し替え（下）より先に効く。** あちらは「画面のボタンはどこにも届かないので
 * Remote Controlへ」と言うもので、計画パネルが出ている間はそれが当てはまらない——
 * パネルの「承認して実装へ進む」「修正を送る」はセッションへ届く唯一の出口になっている。
 * ここで直さないと、**アプリで承認できることが画面のどこからも読み取れない**。
 */
const PLAN_PENDING_DESCRIPTION =
  "エージェントが実装前の計画（アプローチ・変更範囲・懸念点）を提示しました。この方針で実装してよいかを判断してください。";
const PLAN_PENDING_BUTTONS =
  "上の「承認して実装へ進む」で実装が始まります。方針を変えるなら「修正を送る」。";

/**
 * Claude Codeからの質問に画面から答えられるときの差し替え文（#2189）。
 *
 * **計画の差し替え（上）と同じ理由。** 回答パネルが出ている間、選択肢を選んで送ることが
 * セッションへ届く出口になっており、「Remote Controlから答えてください」は当てはまらない。
 */
const QUESTION_PENDING_DESCRIPTION =
  "エージェントが選択肢つきの質問をしています。どれを選ぶかを決めてください。";
const QUESTION_PENDING_BUTTONS =
  "上の「回答を送る」でセッションが続きを進めます。端末で答えるなら「端末・Remote Controlで答える」。";

/**
 * 走っているセッションが入力待ちのときの差し替え文（#1417の判定をそのまま使う）。
 * 画面の承認・修正ボタンは`11.local`が付いている間どこにも届かないため、
 * **唯一効く出口であるRemote Controlだけを案内する。**
 */
const WAITING_INPUT_DESCRIPTION =
  "走っているセッションが入力を待っています。画面の「承認」「修正」は届かないため、Remote Controlから答えてください。";
const WAITING_INPUT_BUTTONS_REMOTE = "答えると確認待ちは自動で外れます。";
const WAITING_INPUT_BUTTONS_FALLBACK =
  "コメント欄の案内からRemote Controlを開いて答えてください。";
const CODEX_WAITING_INPUT_DESCRIPTION =
  "走っているCodexセッションが入力を待っています。画面の「承認」「修正」は届かないため、端末から答えてください。";
const CODEX_WAITING_INPUT_BUTTONS = "端末で答えると確認待ちは自動で外れます。";

/**
 * ローカルセッションが担当しているIssueの案内（#1903）。
 *
 * **入力待ちで止まっていなくても、画面のコメント欄はセッションへ届かない。** それなのに
 * 従来はここで「回答を書いて『承認』を押すと、内容がエージェントへ渡ります」と出し、すぐ下の
 * コメント欄には「承認してもコメントが残るだけで、走っているセッションは動きません」と
 * 正反対のことが出ていた。届かないことをこちら側でも言い、ローカルの承認欄が実際に持っている
 * ボタン（「コメント」「質問する」「確認待ちを外す」）の名前で案内する。
 */
const LOCAL_SESSION_BUTTONS_ALIVE =
  "回答はRemote Controlか端末から伝えます。コメント欄に書いてもセッションには届かず、「確認待ちを外す」は印を外して記録を残すだけです。";
const LOCAL_SESSION_BUTTONS_ENDED =
  "担当していたセッションは動いていません。コメント欄の「確認待ちを外す」で印を片付けられます。続きを頼むにはセッションを起こし直してください。";
/** 回答済み（`01.check-answered`）は元から「読むだけ」の状態なので、押すものだけを言い換える */
const LOCAL_SESSION_BUTTONS_ANSWERED =
  "読み終えたらコメント欄の「確認待ちを外す」を押すと確認待ちが外れます。";

export type ResolveCheckUserGuidanceOptions = {
  /** `checkUserReason`の結果。**`null`（理由ラベル未配布）ならパネルを出さない** */
  reason: CheckUserReason | null;
  placement: CheckUserPlacement;
  /** 走っているセッションが入力待ちか（`isSessionWaitingInput`の結果） */
  sessionWaitingInput?: boolean;
  /**
   * そのIssueをローカルセッションが担当しているか（#1903。`resolveIssueExecutionTarget`の
   * `expectsActionsRun`の裏返し）。**trueの間、コメント欄のボタンはセッションへ届かない。**
   */
  localSession?: boolean;
  /** そのセッションが生きているか（`state === "ALIVE"`）。`localSession`のときの言い方を決める */
  sessionAlive?: boolean;
  /** そのセッションのRemote Control URL（`summarizeIssueSession`の結果）。無ければnull */
  remoteControlUrl?: string | null;
  /**
   * 対応PRのセクションが描かれているか。**マージの行き先が存在しないときに、
   * 押しても何も起きない移動ボタンを出さないため。**
   */
  hasPullRequestSection?: boolean;
  /**
   * 計画への返事を画面から送れる状態か（#2061。`findPlanRequestForIssue`が
   * `WAITING`の行を返したかどうか）。
   *
   * **これがtrueの間、答える先はRemote Controlではなく同じ画面の計画パネル。**
   */
  planDecisionPending?: boolean;
  /**
   * 質問への回答を画面から送れる状態か（#2189。`findQuestionRequestForIssue`が
   * `WAITING`の行を返したかどうか）。
   *
   * **これがtrueの間、答える先はRemote Controlではなく同じ画面の回答パネル。**
   * 計画の承認より先に見る——計画を出したあとに質問することはあり、そのときに
   * 待たれているのは新しい方（質問）だから。
   */
  questionAnswerPending?: boolean;
  /**
   * セッションの状態（`/api/dispatch`）がまだ届いていないか（#1810）。
   *
   * **`sessionWaitingInput`の`false`は「入力待ちではない」と「まだ分からない」の
   * 両方を意味してしまう。** セッションの一覧は取得前も`[]`を返すため、開いた直後は
   * 必ず「入力待ちではない」側に倒れ、承認欄へ送る案内（「承認欄へ移動」）を出してから
   * Remote Controlの案内へ書き換わっていた。**確定するまではどちらも名乗らない**
   * （`useDispatchState`の`isLoaded`を渡す。取得に失敗しても`true`になるので待ち続けない）。
   */
  sessionStatePending?: boolean;
  /** セッションの実装エージェント。CodexにはClaude CodeのRemote Controlが無いため案内を分ける */
  implementationAgent?: CheckUserImplementationAgent;
};

/**
 * `01.check-*`から「次に何をどこで押すのか」を組み立てる（#1663）。
 *
 * `00.check-user`は画面に「確認待ち」であることまでは出していたが、**Remote Controlを開くのか・
 * 対応PRをマージするのか・コメント欄の「承認」を押すのかは書かれていなかった。** 押す場所は
 * 理由（`01.check-*`）と実行先（無人実行かローカルセッションか）で変わるため、判定をここへ寄せる。
 *
 * **理由ラベルが読めないときは`null`を返す**（`checkUserReason`が`00.check-user`とのANDでしか
 * 理由を返さないのと同じ考え方で、行き先を推測で決めない）。呼び出し側は従来どおりの表示に戻る。
 * **セッションの状態が届いていないときも同じく`null`**（`sessionStatePending`・#1810）。
 */
export function resolveCheckUserGuidance({
  reason,
  placement,
  sessionWaitingInput = false,
  localSession = false,
  sessionAlive = false,
  remoteControlUrl = null,
  hasPullRequestSection = true,
  planDecisionPending = false,
  questionAnswerPending = false,
  sessionStatePending = false,
  implementationAgent = "claude",
}: ResolveCheckUserGuidanceOptions): CheckUserGuidance | null {
  if (reason === null) return null;
  // 行き先はローカルセッションが入力待ちかどうかで変わる（下の分岐）。**未確定のまま
  // 出すと必ず「入力待ちではない」側の案内が先に出る**ので、届くまでは何も出さない（#1810）
  if (sessionStatePending) return null;
  const guide = REASON_GUIDE[reason];
  const heading = CHECK_USER_REASON_HEADING[reason];

  // 計画の返事を画面から送れる（#2061）。**入力待ち・ローカル担当の差し替えより先に効く**——
  // どちらも「画面のボタンは届かないのでRemote Controlへ」と言うもので、計画パネルが出ている
  // 間はそれが当てはまらない。マージだけは別（GitHub側の操作で、計画とは待っているものが違う）
  // 質問への回答を画面から送れる（#2189）。**計画の承認より先に効く**——計画を出したあとに
  // 質問することはあり、そのとき待たれているのは新しい方（質問）
  if (questionAnswerPending && reason !== "merge") {
    return {
      reason,
      heading,
      description: QUESTION_PENDING_DESCRIPTION,
      buttons: QUESTION_PENDING_BUTTONS,
      action: { kind: "scroll", target: "question" },
      agentState: guide.agentState,
    };
  }

  if (planDecisionPending && reason !== "merge") {
    return {
      reason,
      heading,
      description: PLAN_PENDING_DESCRIPTION,
      // **パネルはIssue詳細の上部にあり、承認カードの中ではない。** どちらの置き場所
      // （上部のサマリーカード・コメント欄の承認カード）から見ても目的地は別の場所なので、
      // 常に移動ボタンを出す
      buttons: PLAN_PENDING_BUTTONS,
      action: { kind: "scroll", target: "plan" },
      agentState: guide.agentState,
    };
  }

  // マージはGitHub側の操作なので、`11.local`のセッションが入力待ちでも画面から実行できる
  // （`ApprovalActions`がマージ待ちを入力待ちより優先しているのと同じ理由）
  if (sessionWaitingInput && reason !== "merge") {
    const isCodex = implementationAgent === "codex";
    return {
      reason,
      heading,
      description: isCodex ? CODEX_WAITING_INPUT_DESCRIPTION : WAITING_INPUT_DESCRIPTION,
      buttons: isCodex
        ? CODEX_WAITING_INPUT_BUTTONS
        : remoteControlUrl
          ? WAITING_INPUT_BUTTONS_REMOTE
          : WAITING_INPUT_BUTTONS_FALLBACK,
      action: isCodex
        ? null
        : remoteControlUrl
        ? { kind: "remote-control", url: remoteControlUrl }
        : placement === "approval"
          ? null
          : { kind: "scroll", target: "approval" },
      agentState: guide.agentState,
    };
  }

  const target: CheckUserScrollTarget =
    reason === "merge" && hasPullRequestSection ? "pull-requests" : "approval";

  // ローカルセッションが担当しているIssueでは、コメント欄の操作がセッションへ届かない（#1903）。
  // **マージだけは別**（GitHub側の操作なので実際に効く。入力待ちの分岐と同じ理由）
  if (localSession && reason !== "merge") {
    return {
      reason,
      heading,
      description: guide.description,
      buttons:
        reason === "answered"
          ? LOCAL_SESSION_BUTTONS_ANSWERED
          : sessionAlive
            ? LOCAL_SESSION_BUTTONS_ALIVE
            : LOCAL_SESSION_BUTTONS_ENDED,
      // 行き先は「効く出口」を優先する。Remote Controlが取れていれば開くボタン、
      // 取れていなければ操作のある承認欄（そこに居るなら移動ボタンは出さない）
      action:
        sessionAlive && remoteControlUrl
          ? { kind: "remote-control", url: remoteControlUrl }
          : placement === "approval"
            ? null
            : { kind: "scroll", target: "approval" },
      agentState: guide.agentState,
    };
  }

  // 承認カードの中に出すパネルは、それ自体が目的地。移動ボタンは出さない
  const atDestination = placement === "approval" && (target === "approval" || reason === "merge");

  return {
    reason,
    heading,
    description: guide.description,
    buttons: atDestination ? guide.buttonsHere : guide.buttonsAway,
    action: atDestination ? null : { kind: "scroll", target },
    agentState: guide.agentState,
  };
}
