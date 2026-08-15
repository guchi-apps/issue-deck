import { CHECK_USER_REASON_HEADING, type CheckUserReason } from "@/lib/github/approval-labels";

/** 画面内で「次の操作」をする場所（`check-user-focus.ts`がDOMのidへ対応付ける） */
export type CheckUserScrollTarget = "approval" | "pull-requests";

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
  /** エージェントが待っているのか止まっているのか（docs/multi-agent/labels.mdの表と同じ区分） */
  agentState: { tag: string; note: string };
};

type ReasonGuide = {
  description: string;
  /** 移動ボタンを出すとき（目的地が別の場所）の案内 */
  buttonsAway: string;
  /** 目的地に居るときの案内 */
  buttonsHere: string;
  agentState: { tag: string; note: string };
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
    agentState: { tag: "待機中", note: "承認するまで実装は始まりません" },
  },
  input: {
    description:
      "エージェントが自分では決められない点を質問しています。開発環境やスクリーンショットの確認をお願いしている場合もあります。",
    buttonsAway: "コメント欄で回答を書いて「承認」を押すと、内容がエージェントへ渡ります。",
    buttonsHere: "回答を書いて「承認」を押すと、内容がエージェントへ渡ります。",
    agentState: { tag: "待機中", note: "回答するまで先へ進みません" },
  },
  merge: {
    description:
      "自動マージの条件を満たさなかったため、developへのマージはあなたが行う必要があります。",
    buttonsAway: "対応PRの「マージ」を押します。直したい点があれば「修正を依頼する」。",
    buttonsHere: "下の「マージ」を押します。直したい点があれば「修正を依頼する」。",
    agentState: { tag: "待機中", note: "マージするまで次の工程へ進みません" },
  },
  blocked: {
    description:
      "エージェントが作業を続けられずに停止しました。理由（依存の追加・行き詰まり・すでに実装済みなど）は直近のコメントにあります。",
    buttonsAway: "コメント欄に続け方を書いて「修正」。対応不要なら「取り下げ」。",
    buttonsHere: "続け方を書いて「修正」。対応不要なら「取り下げ」。",
    agentState: { tag: "停止中", note: "指示があるまで再開しません" },
  },
  answered: {
    description: "あなたの質問にエージェントが回答しました。読むだけで、実装は再開しません。",
    buttonsAway: "コメント欄の「承認」を押すと確認待ちが外れます。",
    buttonsHere: "読み終えたら「承認」を押すと確認待ちが外れます。",
    agentState: { tag: "待っていません", note: "このIssueは実装フローに乗っていません" },
  },
};

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

export type ResolveCheckUserGuidanceOptions = {
  /** `checkUserReason`の結果。**`null`（理由ラベル未配布）ならパネルを出さない** */
  reason: CheckUserReason | null;
  placement: CheckUserPlacement;
  /** 走っているセッションが入力待ちか（`isSessionWaitingInput`の結果） */
  sessionWaitingInput?: boolean;
  /** そのセッションのRemote Control URL（`summarizeIssueSession`の結果）。無ければnull */
  remoteControlUrl?: string | null;
  /**
   * 対応PRのセクションが描かれているか。**マージの行き先が存在しないときに、
   * 押しても何も起きない移動ボタンを出さないため。**
   */
  hasPullRequestSection?: boolean;
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
 */
export function resolveCheckUserGuidance({
  reason,
  placement,
  sessionWaitingInput = false,
  remoteControlUrl = null,
  hasPullRequestSection = true,
}: ResolveCheckUserGuidanceOptions): CheckUserGuidance | null {
  if (reason === null) return null;
  const guide = REASON_GUIDE[reason];
  const heading = CHECK_USER_REASON_HEADING[reason];

  // マージはGitHub側の操作なので、`11.local`のセッションが入力待ちでも画面から実行できる
  // （`ApprovalActions`がマージ待ちを入力待ちより優先しているのと同じ理由）
  if (sessionWaitingInput && reason !== "merge") {
    return {
      reason,
      heading,
      description: WAITING_INPUT_DESCRIPTION,
      buttons: remoteControlUrl ? WAITING_INPUT_BUTTONS_REMOTE : WAITING_INPUT_BUTTONS_FALLBACK,
      action: remoteControlUrl
        ? { kind: "remote-control", url: remoteControlUrl }
        : placement === "approval"
          ? null
          : { kind: "scroll", target: "approval" },
      agentState: guide.agentState,
    };
  }

  const target: CheckUserScrollTarget =
    reason === "merge" && hasPullRequestSection ? "pull-requests" : "approval";
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
