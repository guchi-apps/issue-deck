import type { SessionPlanRequest, SessionPlanRequestStatus } from "@prisma/client";

import {
  parseClaudeLocalModel,
  parseCodexLocalModel,
  type ClaudeLocalModel,
  type CodexLocalModel,
} from "@/lib/app-settings";
import type { DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { composeAttachments, hasImageMarkdown, splitAttachments } from "@/lib/markdown-attachments";

/**
 * ローカルセッションが提示した計画に対する、画面からの返事（#2061）の**純粋な部分**。
 *
 * **これまで、計画の承認・修正はRemote Controlからしか送れなかった。** 計画そのものは
 * `session-plan.ts`がIssueコメントとして残す（#1342）ので読むことはできたが、答える出口は
 * 端末の承認プロンプトだけで、画面（`LocalSessionWaitingInputNotice`）は
 * 「承認・修正はRemote Controlから伝えてください」と案内するしかなかった。画面の
 * 「追加指示」（#1012）は**承認プロンプト・選択フォームの表示中は送らずに見送る**ため、
 * まさに計画の承認ダイアログが出ている状態では使えない。
 *
 * 決めるのは人（画面のボタン）、受け取るのは計画を投稿した`PreToolUse(ExitPlanMode)`フック
 * （`scripts/session-notify.sh`）。
 *
 * **`send-keys`は使わない。** フックは計画を投稿したあと返事が決まるまで待ち、決まった内容を
 * Claude Code自身の許可判定（`hookSpecificOutput.permissionDecision`）として返す。承認なら
 * `allow`（そのまま実装に入る）、修正なら`deny`＋本文（計画を練り直す）。選択フォームに
 * 答えさせる操作はどこにも無いため、[docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)
 * の「実行体が判断して組み立てた文字列・確定キーの送出」の禁止に触れない。
 *
 * **決まらなければ何も返さない（フェイルオープン）。** 「端末で答える」を押された・待ち時間が
 * 切れた・issue-deckが応答しない、のいずれでもフックは何も出力せずに終え、端末には従来どおりの
 * 承認プロンプトが出る。**この機能が壊れてもセッションが詰まらない**ことを最優先にする。
 *
 * **DBに触る処理は`plan-requests.ts`**（`dispatch-job.ts`と`jobs.ts`、`session-state.ts`と
 * `sessions.ts`の分け方に揃えている）。ここは画面のコンポーネントからもimportされるため、
 * Prismaを引き込まない。
 */

/**
 * 返事を待つ既定の長さ（秒）。
 *
 * **待っている間、端末には承認プロンプトが出ない。** 長くするほど画面から承認できる時間が
 * 延びる一方、端末に座っている人は待たされる（Escで中断すればすぐプロンプトへ戻せる）。
 * 外出中でもissue-deckの画面から答えられるよう12時間を既定にしている。
 * ホスト側の`SESSION_PLAN_WAIT_SECONDS`（`~/.config/issue-deck/notify.env`）で変えられる。
 */
export const SESSION_PLAN_WAIT_SECONDS_DEFAULT = 12 * 60 * 60;

/** 受け取ってよい待ち時間の範囲。フックが壊れた値を送ってきても、ここで常識的な幅へ丸める */
export const SESSION_PLAN_WAIT_SECONDS_MIN = 60;
export const SESSION_PLAN_WAIT_SECONDS_MAX = 24 * 60 * 60;

/**
 * 修正の本文の上限。**Claudeへそのまま渡る文章**なので、追加指示（500文字・1行）より広く取る
 * （計画への指摘は「どこを・なぜ・どう直すか」で数行になる）。
 *
 * **数えるのは人が書いた文章だけで、末尾に並ぶ添付の画像記法は勘定に入れない**（#2425）。
 * 画像1枚で`![スクリーンショット.png](https://…/api/issues/images/<UUID>.png)`＝100文字前後を
 * 使うため、同じ枠で数えると「3枚貼っただけで書ける文章が1割減る」ことになる。
 */
export const SESSION_PLAN_REVISION_MAX_LENGTH = 2000;

/**
 * 画面の「アーティファクトの作成を依頼」が修正として送る固定の依頼文（#3493）。
 * **本文の正はここ**で、人が書く修正文ではない。`25.artifact-required`なのに見た目が
 * 未公開のまま計画が出たときに、計画の練り直しへ相乗りさせて公開を頼む。
 */
export const PLAN_ARTIFACT_REQUEST_TEXT =
  "見た目のアーティファクトがまだ公開されていません。変更する画面の見た目を自己完結HTMLのアーティファクトとして公開し、そのURLを含めた計画を出し直してください。";

/**
 * 画面の「レビューを反映して計画を出し直す」が修正として送る固定の依頼文（#3521）。
 * **本文の正はここ**で、人が書く修正文ではない。
 */
export const PLAN_REVIEW_REFLECT_REQUEST_TEXT =
  "計画レビュー（<!-- supervisor:plan-review -->付きのコメント）が届いています。指摘を自分で確かめ、正しいものを取り込んだ計画を出し直してください。取り込まなかった指摘は理由を添えてください。応答はIssueコメントの末尾に<!-- issue-deck-agent:plan-reviser -->を付けて残してください。";

/** 計画レビューの指摘1件に対する、人の判断（#3554） */
export type PlanReviewFindingDecision = {
  /** レビューが振った番号 */
  number: number;
  title: string;
  decision: "apply" | "skip";
  /** 見送る理由。任意 */
  reason?: string;
};

/** 計画レビューの「人が決める判断」1件に対する、人の選択（#3660）。`letter`が`null`なら「セッションに任せる」 */
export type PlanReviewChoice = {
  number: number;
  title: string;
  letter: string | null;
  /** 選んだ選択肢の題。任せるときは無し */
  label?: string;
};

/**
 * 指摘ごとの判断を、修正として送る依頼文にする（#3554）。
 *
 * **載せるのは番号・見出し・判断・見送る理由だけ。** 指摘の本文・根拠・提案は
 * `PLAN_REVIEW_REFLECT_REQUEST_TEXT`と同じくレビューコメントを読ませる。本文を引用すると
 * 3件程度で`SESSION_PLAN_REVISION_MAX_LENGTH`に届き、`parseSessionPlanRevision`に弾かれる。
 * **見出しと理由は長ければ切り詰め、それでも収まらなければ枠を狭めて組み直す**
 * （どんな件数でも上限内の文を返す）。
 */
export function buildPlanReviewDecisionRequestText(
  decisions: readonly PlanReviewFindingDecision[],
  choices: readonly PlanReviewChoice[] = [],
  additional = "",
): string {
  // 追記は選択結果の末尾に連結する（#3829）。**サーバーは添付を除いた本文で上限を判定する**ので、
  // 追記は本文と添付に分け、本文の長さだけを枠から引く。切り詰めは選択結果の側だけに掛け、
  // 追記の本文と末尾の画像記法は必ず残す
  const { body: additionalBody, attachments } = splitAttachments(additional);
  const extra = additionalBody.trim();
  const extraSection = extra === "" ? "" : `${ADDITIONAL_HEADING}${extra}`;
  const budget = SESSION_PLAN_REVISION_MAX_LENGTH - extraSection.length;
  const withExtra = (base: string) => composeAttachments(`${base}${extraSection}`, attachments);

  for (const [titleMax, reasonMax] of [
    [120, 300],
    [60, 120],
    [30, 40],
    [16, 0],
  ] as const) {
    const text = composePlanReviewDecisionText(decisions, choices, titleMax, reasonMax);
    if (text.length <= budget) return withExtra(text);
  }
  // 指摘が100件を超えるような異常な場合だけここに来る。途中で切っても判断の先頭は残る
  const base = composePlanReviewDecisionText(decisions, choices, 16, 0);
  return withExtra(`${base.slice(0, Math.max(budget - 1, 0))}…`);
}

const ADDITIONAL_HEADING = "\n\n追加の修正（上の判断に加えて、次も計画へ反映してください）:\n";

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function composePlanReviewDecisionText(
  decisions: readonly PlanReviewFindingDecision[],
  choices: readonly PlanReviewChoice[],
  titleMax: number,
  reasonMax: number,
): string {
  const line = (item: PlanReviewFindingDecision) => {
    const reason = item.reason?.trim();
    const suffix =
      item.decision === "skip" && reason && reasonMax > 0 ? `（理由: ${clip(reason, reasonMax)}）` : "";
    return `- ${item.number}. ${clip(item.title, titleMax)}${suffix}`;
  };
  const applied = decisions.filter((item) => item.decision === "apply");
  const skipped = decisions.filter((item) => item.decision === "skip");

  const choiceLine = (item: PlanReviewChoice) =>
    item.letter === null
      ? `- 判断${item.number}. ${clip(item.title, titleMax)} → セッションに任せる`
      : `- 判断${item.number}. ${clip(item.title, titleMax)} → ${item.letter}. ${clip(item.label ?? "", titleMax)}`;

  return [
    "計画レビュー（<!-- supervisor:plan-review -->付きのコメント）について、人が次のとおり判断しました。" +
      (decisions.length > 0
        ? "「反映する」の指摘は自分で確かめたうえで計画へ取り込み、「見送る」の指摘は取り込まずに、計画を出し直してください。確かめた結果、反映できない指摘があれば理由を添えてください。"
        : "計画を出し直してください。") +
      (choices.length > 0
        ? "「判断」は人が選んだ選択肢のとおりに計画へ反映してください（選択肢の内容はレビューコメントに書かれています）。「セッションに任せる」の判断は、自分で決めたうえで理由を添えてください。"
        : "") +
      "応答はIssueコメントの末尾に<!-- issue-deck-agent:plan-reviser -->を付けて残してください。",
    ...(applied.length > 0 ? ["", "反映する:", ...applied.map(line)] : []),
    ...(skipped.length > 0 ? ["", "見送る:", ...skipped.map(line)] : []),
    ...(choices.length > 0 ? ["", "判断:", ...choices.map(choiceLine)] : []),
  ].join("\n");
}

/**
 * 修正1回に添付できる画像の枚数（#2425）。**Claudeへ渡す`deny`の理由に載る**ので、
 * URLの羅列で理由が埋まらない程度に抑える。画面はこの枚数で送信を止める。
 */
export const SESSION_PLAN_REVISION_MAX_ATTACHMENTS = 10;

/**
 * 画面へ出すために保存する計画本文の上限。
 *
 * 全文はIssueコメントにも残っている（`session-plan.ts`）が、**画面はコメントの取得に
 * 依存させない**——ディスパッチの状態と同じ1本のポーリングで読めるようにするため。
 * 極端に長い計画で行が肥大しないよう、ここで切って「全文はコメントで」と案内する。
 */
export const SESSION_PLAN_STORED_LIMIT = 20000;

/** 決めたあと、結果を画面に出しておく長さ */
export const SESSION_PLAN_DECIDED_VISIBLE_MS = 3 * 60 * 1000;

/** 画面のボタンが送ってくる決め方 */
export type SessionPlanDecision = "approve" | "revise" | "defer";

/** 計画承認後に、現在と同じCLIの新規セッションへ渡すモデルを検証する。 */
export function parseSessionPlanHandoffModel(
  value: unknown,
  agent: DispatchAgent,
): ClaudeLocalModel | CodexLocalModel | null {
  return agent === "codex" ? parseCodexLocalModel(value) : parseClaudeLocalModel(value);
}

export function parseSessionPlanDecision(value: unknown): SessionPlanDecision | null {
  if (value === "approve" || value === "revise" || value === "defer") return value;
  return null;
}

/**
 * 修正の本文。**改行は通す**（複数行の指摘を書くため）が、それ以外の制御文字は弾く。
 * 追加指示（`parseSessionInstruction`）が1行しか通さないのは端末へ`send-keys`で流すためで、
 * こちらはHTTPのJSONとしてフックへ渡り、Claude Codeが読むだけなので同じ制約は要らない。
 */
export function parseSessionPlanRevision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // 改行・タブ以外の制御文字だけを弾く
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) return null;
  // **上限を数えるのは人が書いた文章だけ**（#2425）。末尾の画像記法は添付なので数えず、
  // 代わりに枚数で抑える。**画像だけ（文章なし）の修正も通す**——「この見た目にして」と
  // スクリーンショットを1枚貼るのは、文章を書くより早くて正確な伝え方になる。
  const { body, attachments } = splitAttachments(trimmed);
  if (body.length > SESSION_PLAN_REVISION_MAX_LENGTH) return null;
  if (attachments.length > SESSION_PLAN_REVISION_MAX_ATTACHMENTS) return null;
  return trimmed;
}

/**
 * 修正の本文を、Claudeが受け取る`deny`の理由に仕立てる（#2425）。
 *
 * **フックが渡すのは文字列だけで、画像そのものは渡らない。** 画像記法のURLをそのまま置くと、
 * Claudeは「URLが書いてある」ことしか読み取れず、貼った本人は見せたつもりで見せられていない。
 * 取りに行き方（取得スクリプトで落として`Read`で開く）を添えて、確かめる手順まで書く。
 * `WebFetch`ではなくファイルへ落として`Read`なのは、`WebFetch`がHTMLをMarkdown化して要約する
 * ツールで**画像そのものをClaudeに見せられない**ため（`docs/multi-agent/dispatch.md`・#195）。
 *
 * **画像の配信は認証必須**（#2967）なので素の`curl`では401になる。スクリプトはフックと同じ
 * issue-deck本体の`scripts/`（`~/apps/issue-deck/scripts/`。#1274）に置いてあり、
 * `dispatch.env`の鍵で取得する。worktreeが他リポジトリでも届くよう絶対パスで書く。
 *
 * 画像が無ければ**本文をそのまま返す**（要らない案内で理由を薄めない）。
 */
export function buildPlanRevisionReason(revisionText: string): string {
  if (!hasImageMarkdown(revisionText)) return revisionText;
  return [
    revisionText,
    "",
    "---",
    "上の修正には画像が添付されています（`![...](...)`）。**この文面に画像そのものは含まれていません。**",
    "次のように取得し、出力されたパスを`Read`で開いて中身を確かめてから計画を練り直してください",
    "（画像の配信は認証が必要なので、URLを直接`curl`・`WebFetch`しても読めません）。",
    "",
    "```bash",
    "~/apps/issue-deck/scripts/fetch-issue-images.sh '<画像のURL>'",
    "```",
  ].join("\n");
}

/**
 * フックが申告してくる待ち時間（秒）。範囲外・壊れた値は既定へ倒す。
 *
 * **`0`だけは特別で、そのまま`0`を返す**（＝待たない）。ホスト側で
 * `SESSION_PLAN_WAIT_SECONDS=0`にしたときにここで下限へ丸めてしまうと、フックは待たないのに
 * 画面には「承認を待っています」が既定の12時間ぶん残り、押しても誰も受け取らないパネルになる。
 */
export function parseSessionPlanWaitSeconds(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return SESSION_PLAN_WAIT_SECONDS_DEFAULT;
  const rounded = Math.floor(seconds);
  if (rounded <= 0) return 0;
  if (rounded < SESSION_PLAN_WAIT_SECONDS_MIN) return SESSION_PLAN_WAIT_SECONDS_MIN;
  if (rounded > SESSION_PLAN_WAIT_SECONDS_MAX) return SESSION_PLAN_WAIT_SECONDS_MAX;
  return rounded;
}

/** 画面へ出す計画本文。全文はIssueコメントにあるので、長すぎるものは切って案内へ寄せる */
export function truncatePlanForPanel(plan: string): string {
  const trimmed = plan.trim();
  if (trimmed.length <= SESSION_PLAN_STORED_LIMIT) return trimmed;
  return `${trimmed.slice(0, SESSION_PLAN_STORED_LIMIT)}\n\n（長すぎるため以降を省略しました。全文はIssueのコメントで確認してください）`;
}

/** 画面へ返す形。**修正の本文は返さない**（押した人が書いたものが画面に戻る必要は無い） */
export type SessionPlanRequestView = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
  plan: string;
  status: SessionPlanRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** フックが結論を受け取ったか。受け取る前でも押し直しはできない（決まった時点で確定） */
  delivered: boolean;
  /** 計画レビューを受けて自動で修正を送った回か（人が押した回ではない） */
  autoReflected?: boolean;
  pollCount?: number;
  lastPolledAt?: string | null;
  decisionObservedAt?: string | null;
  deliveryStatus?: string | null;
  deliveryReportedAt?: string | null;
  deliveryExitCode?: number | null;
  deliverySummary?: string | null;
};

export function toSessionPlanRequestView(row: SessionPlanRequest): SessionPlanRequestView {
  return {
    id: row.id,
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
    hostName: row.hostName,
    plan: row.plan,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    delivered: row.deliveredAt !== null,
    autoReflected: row.status === "REVISION_REQUESTED" && row.decidedByUserId === null,
    pollCount: row.pollCount ?? 0,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    decisionObservedAt: row.decisionObservedAt?.toISOString() ?? null,
    deliveryStatus: row.deliveryStatus ?? null,
    deliveryReportedAt: row.deliveryReportedAt?.toISOString() ?? null,
    deliveryExitCode: row.deliveryExitCode ?? null,
    deliverySummary: row.deliverySummary ?? null,
  };
}

export const SESSION_PLAN_DELIVERY_STATUSES = [
  "DECISION_OBSERVED",
  "PROCESSED",
  "PROCESS_FAILED",
  "COMMUNICATION_FAILED",
] as const;
export type SessionPlanDeliveryStatus = (typeof SESSION_PLAN_DELIVERY_STATUSES)[number];

/** 画面のボタンと`SessionPlanRequestStatus`の対応 */
export const SESSION_PLAN_DECISION_STATUS: Record<SessionPlanDecision, SessionPlanRequestStatus> = {
  approve: "APPROVED",
  revise: "REVISION_REQUESTED",
  defer: "DEFERRED",
};

/** 画面に出す価値がある（＝まだ何か起きうる）状態か。押した直後の結果表示もここに含める */
export function isVisibleSessionPlanRequest(
  view: Pick<SessionPlanRequestView, "status" | "decidedAt">,
  now: Date,
): boolean {
  if (view.status === "WAITING") return true;
  // 押した直後の結果（「承認を送りました」）は少しの間だけ出す。押した本人が
  // 「効いたのか」を確かめられればよく、いつまでも残す種類の情報ではない
  if (!view.decidedAt) return false;
  return now.getTime() - new Date(view.decidedAt).getTime() < SESSION_PLAN_DECIDED_VISIBLE_MS;
}

/**
 * このIssueに対する、画面へ出す返事待ちを1件選ぶ。
 *
 * **`WAITING`を最優先する。** 計画を出し直すと古い行は`EXPIRED`になるが、押した直後の
 * 結果表示（`SESSION_PLAN_DECIDED_VISIBLE_MS`のあいだ残る行）と同時に並ぶことがある。
 * 新しい計画が出ているなら、そちらが唯一の操作対象になる。
 */
export function findPlanRequestForIssue(
  requests: readonly SessionPlanRequestView[],
  repositoryFullName: string,
  issueNumber: number,
  now: Date = new Date(),
  options: { sessionWaitingInput?: boolean } = {},
): SessionPlanRequestView | null {
  const all = requests.filter(
    (request) =>
      request.repositoryFullName === repositoryFullName && request.issueNumber === issueNumber,
  );
  const mine = all.filter((request) => isVisibleSessionPlanRequest(request, now));
  if (mine.length === 0) {
    // 画面の返事待ちが畳まれた（待ち時間切れ・「端末で答える」・フックの離脱）あとも、**セッションが
    // 入力待ちのままなら端末には承認プロンプトが残っている**（#3711）。結果表示の猶予（3分）で
    // 消すと、端末には計画が出ているのにissue-deckには何も出ない状態になる。最新の計画がそのどちらか
    // のときだけ、セッションが動き出すまで案内を出し続ける
    if (options.sessionWaitingInput) {
      const latest = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (latest && (latest.status === "EXPIRED" || latest.status === "DEFERRED")) return latest;
    }
    return null;
  }
  const waiting = mine.find((request) => request.status === "WAITING");
  if (waiting) return waiting;
  return [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** 画面から押せなかった理由。ボタンを消さずに理由を出す（起動ボタン・代行実行と同じ作法） */
export type SessionPlanDecisionRejection = "not_found" | "already_decided" | "expired";

export function describeSessionPlanDecisionRejection(
  rejection: SessionPlanDecisionRejection,
): string {
  switch (rejection) {
    case "not_found":
      return "この計画の返事待ちは残っていません（画面を更新してください）";
    case "already_decided":
      return "この計画にはすでに返事が送られています";
    case "expired":
      return "待ち時間が切れました。端末に承認プロンプトが出ているので、Remote Controlか端末から答えてください";
  }
}

/**
 * 画面から押したことをIssueへ残す本文。
 *
 * **端末のやり取りはIssueに残らない**という運用上の弱点は、画面から押した承認にもそのまま
 * 当てはまる。誰がいつ何を送ったのかが残らないと、後から計画の変遷を追えない。
 *
 * 投稿はissue-deckのGitHub App名義になるため、末尾に投稿者マーカー（`posterMarker`）を
 * 付けて、画面上は押した本人の発言として出す（カンバンのStatus変更で起動したコメントと同じ）。
 */
export function buildSessionPlanDecisionCommentBody(params: {
  decision: SessionPlanDecision;
  revisionText: string | null;
  posterMarker: string;
}): string {
  const lines: string[] = [];
  switch (params.decision) {
    case "approve":
      lines.push("✅ **計画を承認しました**（issue-deckの画面から）。セッションは実装へ進みます。");
      break;
    case "revise":
      lines.push("✏️ **計画へ修正を送りました**（issue-deckの画面から）。", "", "> 修正の内容");
      for (const line of (params.revisionText ?? "").split("\n")) {
        lines.push(`> ${line}`);
      }
      lines.push("", "セッションはこの内容で計画を練り直します。");
      break;
    case "defer":
      lines.push(
        "⌨️ **端末で答えることにしました**（issue-deckの画面から）。端末に承認プロンプトが出ています。",
      );
      break;
  }
  lines.push("", params.posterMarker);
  return lines.join("\n");
}
