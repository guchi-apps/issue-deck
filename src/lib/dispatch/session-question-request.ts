import type { SessionQuestionRequest, SessionQuestionRequestStatus } from "@prisma/client";

/**
 * ローカルセッションが`AskUserQuestion`で聞いた質問への、画面からの回答（#2189）の
 * **純粋な部分**。
 *
 * **これまで、Claude Codeからの質問に答えられるのは端末とRemote Controlだけだった。**
 * 画面（`LocalSessionWaitingInputNotice`）は「Remote Controlから答えてください」と案内する
 * しかなく、スマホから選択肢を1つ選ぶだけのためにTUIを開く必要があった。
 *
 * 決めるのは人（画面のボタン）、受け取るのは質問を投げた`PreToolUse(AskUserQuestion)`フック
 * （`scripts/session-notify.sh`）。**計画の承認（#2061・`session-plan-request.ts`）と
 * 同じ作りで、待っている中身が「1本のテキスト」から「選択肢つきの質問」に変わったもの。**
 *
 * **`send-keys`は使わない。** フックは質問を送ったあと回答が決まるまで待ち、決まった回答を
 * Claude Code自身の許可判定（`hookSpecificOutput.permissionDecision`＝`allow`）に
 * `updatedInput.answers`を添えて返す。`AskUserQuestion`は`answers`が埋まっていればその値を
 * そのまま結果にするので、**選択フォームに答えさせる操作はどこにも無い**
 * （[docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)の禁止に触れない）。
 *
 * **決まらなければ何も返さない（フェイルオープン）。** 「端末で答える」を押された・待ち時間が
 * 切れた・issue-deckが応答しない、のいずれでもフックは何も出力せずに終え、端末には従来どおりの
 * 選択フォームが出る。**この機能が壊れてもセッションが詰まらない**ことを最優先にする。
 *
 * **DBに触る処理は`question-requests.ts`**（`session-plan-request.ts`と`plan-requests.ts`の
 * 分け方に揃えている）。ここは画面のコンポーネントからもimportされるため、Prismaの
 * **型以外**を引き込まない。
 */

/**
 * 回答を待つ既定の長さ（秒）。
 *
 * **待っている間、端末には選択フォームが出ない。** 計画の承認（30分）と同じにしてある——
 * どちらも「スマホから答えるまでの猶予」であり、別の値にする理由が無い。
 * ホスト側の`SESSION_QUESTION_WAIT_SECONDS`（`~/.config/issue-deck/notify.env`）で変えられる。
 */
export const SESSION_QUESTION_WAIT_SECONDS_DEFAULT = 1800;

/** 受け取ってよい待ち時間の範囲。フックが壊れた値を送ってきても、ここで常識的な幅へ丸める */
export const SESSION_QUESTION_WAIT_SECONDS_MIN = 60;
export const SESSION_QUESTION_WAIT_SECONDS_MAX = 3600;

/**
 * `AskUserQuestion`のスキーマ上の上限（Claude Code 2.1.241の実測）。
 *
 * **超えた入力は弾かずに切り詰める。** ここで弾くと、質問が画面に出ないまま端末の選択フォーム
 * だけが残る——上限が将来緩んだときに、issue-deckの側が理由で機能を落とすことになる。
 */
export const SESSION_QUESTION_MAX_QUESTIONS = 4;
export const SESSION_QUESTION_MAX_OPTIONS = 4;

/** 1つの文字列（質問文・選択肢のラベル・説明）として保存する長さの上限 */
export const SESSION_QUESTION_TEXT_LIMIT = 500;

/**
 * 選択肢に添えられる`preview`（モックアップ・コード片）の上限。
 *
 * **本文より広く取る。** 見た目の案を並べて選ばせる使い方があり、そこが切れると画面から
 * 選ぶ判断ができない。それでも上限を置くのは、1行のTEXT列に数百KBが載るのを避けるため。
 */
export const SESSION_QUESTION_PREVIEW_LIMIT = 4000;

/** 「その他」の自由記述の上限。**そのままClaudeへ渡る文章**なので、計画の修正と同じ幅を取る */
export const SESSION_QUESTION_FREE_TEXT_MAX_LENGTH = 2000;

/** 決めたあと、結果を画面に出しておく長さ */
export const SESSION_QUESTION_DECIDED_VISIBLE_MS = 3 * 60 * 1000;

/**
 * 複数選択の回答をつなぐ区切り。
 *
 * **Claude Code側の受け取り方に合わせている。** `AskUserQuestion`の`answers`は
 * 「質問文 → 回答文字列」で、複数選択はカンマ区切りの1本の文字列として扱われる
 * （出力スキーマの説明にも "multi-select answers are comma-separated" とある）。
 */
export const SESSION_QUESTION_ANSWER_SEPARATOR = ", ";

/** 選択肢1つ。`AskUserQuestion`の`options`の要素と同じ形 */
export type SessionQuestionOption = {
  label: string;
  description: string;
  /** モックアップ・コード片。無いことの方が多い */
  preview?: string;
};

/** 質問1つ。`AskUserQuestion`の`questions`の要素と同じ形 */
export type SessionQuestion = {
  question: string;
  header: string;
  options: SessionQuestionOption[];
  multiSelect: boolean;
};

/**
 * フックから届いた`questions`を、画面に出してよい形へ揃える。
 *
 * **形が想定と違う質問は落とし、残った質問だけを返す。** 1つでも壊れていたら全部を捨てる作りに
 * すると、Claude Codeの側でスキーマが増えた時点で機能ごと止まる。**1つも残らなければ`null`**
 * （＝待ちを作らない。端末の選択フォームに任せる）。
 */
export function parseSessionQuestions(value: unknown): SessionQuestion[] | null {
  if (!Array.isArray(value)) return null;

  const questions: SessionQuestion[] = [];
  for (const raw of value.slice(0, SESSION_QUESTION_MAX_QUESTIONS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const question = clip(entry.question, SESSION_QUESTION_TEXT_LIMIT);
    if (!question) continue;
    // 質問文は回答の照合キー（`answers`のキー）なので、重複したものは後から区別できない
    if (questions.some((existing) => existing.question === question)) continue;

    const options: SessionQuestionOption[] = [];
    const rawOptions = Array.isArray(entry.options) ? entry.options : [];
    for (const rawOption of rawOptions.slice(0, SESSION_QUESTION_MAX_OPTIONS)) {
      if (typeof rawOption !== "object" || rawOption === null) continue;
      const option = rawOption as Record<string, unknown>;
      const label = clip(option.label, SESSION_QUESTION_TEXT_LIMIT);
      if (!label) continue;
      if (options.some((existing) => existing.label === label)) continue;
      const preview = clip(option.preview, SESSION_QUESTION_PREVIEW_LIMIT);
      options.push({
        label,
        description: clip(option.description, SESSION_QUESTION_TEXT_LIMIT) ?? "",
        ...(preview ? { preview } : {}),
      });
    }
    // 選択肢が1つしかない質問は、画面に出しても選ぶ余地が無い
    if (options.length < 2) continue;

    questions.push({
      question,
      header: clip(entry.header, SESSION_QUESTION_TEXT_LIMIT) ?? "",
      options,
      multiSelect: entry.multiSelect === true,
    });
  }

  return questions.length > 0 ? questions : null;
}

/** DBへ入れる形（JSON文字列）。読み出しは`parseStoredSessionQuestions` */
export function serializeSessionQuestions(questions: readonly SessionQuestion[]): string {
  return JSON.stringify(questions);
}

/**
 * DBに入っている`questions`を読み出す。**壊れていれば空配列**（画面は「質問を読めません」と
 * 出して端末へ寄せる。ここで例外にすると一覧の取得ごと落ちる）。
 */
export function parseStoredSessionQuestions(stored: string): SessionQuestion[] {
  try {
    return parseSessionQuestions(JSON.parse(stored)) ?? [];
  } catch {
    return [];
  }
}

/** 画面が送ってくる、1問ぶんの回答 */
export type SessionQuestionAnswerInput = {
  question: string;
  /** 選んだ選択肢のラベル。単一選択なら1つまで */
  options: string[];
  /** 「その他」の自由記述。空なら選択肢だけを送る */
  text?: string;
};

/**
 * 画面から届いた回答を、Claude Codeへ渡す`answers`（質問文 → 回答文字列）へ変換する。
 *
 * **質問の側を正として突き合わせる。** 画面が送ってくるのは人の操作の結果だが、送り先は
 * Claude Codeのツール入力なので、**保存してある質問に無いラベルは通さない**（`updatedInput`は
 * ツールのスキーマ検証を通り、外れると回答ごと`deny`になる）。
 *
 * **すべての質問に答えが要る。** 1問でも空だとツールの結果が「(no option selected)」になり、
 * 何を聞かれて何を答えたのかが後から読めない。押せるかどうかの判定は画面側にもあるが、
 * **正はここ**（画面を通さずに叩かれても成立させない）。
 */
export function buildSessionQuestionAnswers(
  questions: readonly SessionQuestion[],
  value: unknown,
): Record<string, string> | null {
  if (!Array.isArray(value)) return null;

  const answers: Record<string, string> = {};
  for (const question of questions) {
    const raw = value.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).question === question.question,
    ) as Record<string, unknown> | undefined;
    if (!raw) return null;

    const labels = Array.isArray(raw.options) ? raw.options : [];
    const selected: string[] = [];
    for (const label of labels) {
      if (typeof label !== "string") return null;
      // 保存してある選択肢に無いラベルは、画面が壊れているか直接叩かれたかのどちらか
      if (!question.options.some((option) => option.label === label)) return null;
      if (!selected.includes(label)) selected.push(label);
    }
    if (!question.multiSelect && selected.length > 1) return null;

    const freeText = parseSessionQuestionFreeText(raw.text);
    if (raw.text !== undefined && raw.text !== "" && freeText === null) return null;

    const parts = freeText ? [...selected, freeText] : selected;
    if (parts.length === 0) return null;
    answers[question.question] = parts.join(SESSION_QUESTION_ANSWER_SEPARATOR);
  }

  return answers;
}

/**
 * 「その他」の自由記述。**改行は通す**（複数行で書き足すため）が、それ以外の制御文字は弾く。
 * 追加指示（`parseSessionInstruction`）が1行しか通さないのは端末へ`send-keys`で流すためで、
 * こちらはHTTPのJSONとしてフックへ渡り、Claude Codeが読むだけなので同じ制約は要らない。
 */
export function parseSessionQuestionFreeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_QUESTION_FREE_TEXT_MAX_LENGTH) return null;
  // 改行・タブ以外の制御文字だけを弾く
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * フックが申告してくる待ち時間（秒）。範囲外・壊れた値は既定へ倒す。
 *
 * **`0`だけは特別で、そのまま`0`を返す**（＝待たない）。ホスト側で
 * `SESSION_QUESTION_WAIT_SECONDS=0`にしたときにここで下限へ丸めてしまうと、フックは待たないのに
 * 画面には「回答を待っています」が既定の30分ぶん残り、押しても誰も受け取らないパネルになる。
 */
export function parseSessionQuestionWaitSeconds(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return SESSION_QUESTION_WAIT_SECONDS_DEFAULT;
  const rounded = Math.floor(seconds);
  if (rounded <= 0) return 0;
  if (rounded < SESSION_QUESTION_WAIT_SECONDS_MIN) return SESSION_QUESTION_WAIT_SECONDS_MIN;
  if (rounded > SESSION_QUESTION_WAIT_SECONDS_MAX) return SESSION_QUESTION_WAIT_SECONDS_MAX;
  return rounded;
}

/** 画面へ返す形。**回答の本文も返す**（押した直後に「何を送ったか」を出すため） */
export type SessionQuestionRequestView = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
  questions: SessionQuestion[];
  answers: Record<string, string> | null;
  status: SessionQuestionRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** フックが回答を受け取ったか。受け取る前でも押し直しはできない（決まった時点で確定） */
  delivered: boolean;
};

export function toSessionQuestionRequestView(
  row: SessionQuestionRequest,
): SessionQuestionRequestView {
  return {
    id: row.id,
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
    hostName: row.hostName,
    questions: parseStoredSessionQuestions(row.questions),
    answers: parseStoredSessionAnswers(row.answers),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    delivered: row.deliveredAt !== null,
  };
}

/** DBに入っている`answers`を読み出す。壊れていれば`null`（「回答は残っていない」として扱う） */
export function parseStoredSessionAnswers(stored: string | null): Record<string, string> | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") answers[key] = value;
    }
    return Object.keys(answers).length > 0 ? answers : null;
  } catch {
    return null;
  }
}

/** 画面のボタンが送ってくる決め方 */
export type SessionQuestionDecision = "answer" | "defer";

export function parseSessionQuestionDecision(value: unknown): SessionQuestionDecision | null {
  if (value === "answer" || value === "defer") return value;
  return null;
}

/** 画面のボタンと`SessionQuestionRequestStatus`の対応 */
export const SESSION_QUESTION_DECISION_STATUS: Record<
  SessionQuestionDecision,
  SessionQuestionRequestStatus
> = {
  answer: "ANSWERED",
  defer: "DEFERRED",
};

/** 画面に出す価値がある（＝まだ何か起きうる）状態か。押した直後の結果表示もここに含める */
export function isVisibleSessionQuestionRequest(
  view: Pick<SessionQuestionRequestView, "status" | "decidedAt">,
  now: Date,
): boolean {
  if (view.status === "WAITING") return true;
  // 押した直後の結果（「回答を送りました」）は少しの間だけ出す。押した本人が
  // 「効いたのか」を確かめられればよく、いつまでも残す種類の情報ではない
  if (!view.decidedAt) return false;
  return now.getTime() - new Date(view.decidedAt).getTime() < SESSION_QUESTION_DECIDED_VISIBLE_MS;
}

/**
 * このIssueに対する、画面へ出す回答待ちを1件選ぶ。
 *
 * **`WAITING`を最優先する。** 続けて質問すると古い行は`EXPIRED`になるが、押した直後の
 * 結果表示（`SESSION_QUESTION_DECIDED_VISIBLE_MS`のあいだ残る行）と同時に並ぶことがある。
 * 新しい質問が出ているなら、そちらが唯一の操作対象になる。
 */
export function findQuestionRequestForIssue(
  requests: readonly SessionQuestionRequestView[],
  repositoryFullName: string,
  issueNumber: number,
  now: Date = new Date(),
): SessionQuestionRequestView | null {
  const mine = requests.filter(
    (request) =>
      request.repositoryFullName === repositoryFullName &&
      request.issueNumber === issueNumber &&
      isVisibleSessionQuestionRequest(request, now),
  );
  if (mine.length === 0) return null;
  const waiting = mine.find((request) => request.status === "WAITING");
  if (waiting) return waiting;
  return [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** 画面から押せなかった理由。ボタンを消さずに理由を出す（計画の承認と同じ作法） */
export type SessionQuestionDecisionRejection = "not_found" | "already_decided" | "expired";

export function describeSessionQuestionDecisionRejection(
  rejection: SessionQuestionDecisionRejection,
): string {
  switch (rejection) {
    case "not_found":
      return "この質問の回答待ちは残っていません（画面を更新してください）";
    case "already_decided":
      return "この質問にはすでに回答が送られています";
    case "expired":
      return "待ち時間が切れました。端末に選択フォームが出ているので、Remote Controlか端末から答えてください";
  }
}

/**
 * 画面から答えたことをIssueへ残す本文。
 *
 * **端末のやり取りはIssueに残らない**という運用上の弱点は、画面から送った回答にもそのまま
 * 当てはまる。誰がいつ何を選んだのかが残らないと、後から仕様が決まった経緯を追えない。
 *
 * **質問と回答を1件のコメントにまとめる。** 質問が出た時点では投稿しない——聞かれただけで
 * 答えていないものがIssueに増えると、後から読む人には何が決まったのか分からない。
 *
 * 投稿はissue-deckのGitHub App名義になるため、末尾に投稿者マーカー（`posterMarker`）を
 * 付けて、画面上は押した本人の発言として出す（計画への返事と同じ）。
 */
export function buildSessionQuestionAnswerCommentBody(params: {
  decision: SessionQuestionDecision;
  questions: readonly SessionQuestion[];
  answers: Record<string, string> | null;
  posterMarker: string;
}): string {
  const lines: string[] = [];
  if (params.decision === "defer") {
    lines.push(
      "⌨️ **端末で答えることにしました**（issue-deckの画面から）。端末に選択フォームが出ています。",
    );
  } else {
    lines.push("🙋 **質問に回答しました**（issue-deckの画面から）。", "");
    for (const question of params.questions) {
      const answer = params.answers?.[question.question];
      lines.push(`- **${question.question}**`);
      lines.push(`  - ${answer ?? "（回答なし）"}`);
    }
    lines.push("", "セッションはこの回答のまま作業を続けます。");
  }
  lines.push("", params.posterMarker);
  return lines.join("\n");
}

/** 文字列として使える値だけを、上限まで切って返す。空白だけ・空文字は`null` */
function clip(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}
