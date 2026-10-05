import type { RepairKind } from "@/lib/github/pull-request-repair";

/** 会話が指している1件（Issue・PRは同じ番号空間なので、取得してから種別が決まる） */
export type ChatTarget = {
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
};

/** 実行（または確認待ち）にした操作の記録。会話コンテキストの`actions`に積む */
export type ChatActionRecord = {
  type: "repair" | "create_issue";
  status: "started" | "created" | "failed";
  repo: string;
  number: number | null;
  at: string;
  message: string;
};

/**
 * 会話内で保持するコンテキスト（#3975）。「それ直して」「もう一度確認して」「別Issueにして」を
 * 解釈する材料で、サーバー側のDBに保存する（クライアントの申告を信用しない）。
 */
export type ChatContext = {
  /** 番号だけが書かれたときに補う既定のrepository（`owner/repo`） */
  repo: string | null;
  /** 直前の発言で見せた対象。発言のたびに置き換える（1件なら「それ」が指す、複数なら聞き返す） */
  targets: ChatTarget[];
  actions: ChatActionRecord[];
};

export const EMPTY_CHAT_CONTEXT: ChatContext = { repo: null, targets: [], actions: [] };

/** 文章から読み取った意図。**実行はせず**、解決（`resolveIntent`）と確認を経る */
export type ChatIntent =
  | { type: "status"; refs: ChatRef[] }
  | { type: "recheck" }
  | { type: "merge_check" }
  | { type: "repair"; ref: ChatRef | null }
  | { type: "create_issue"; title: string | null }
  | { type: "unknown" };

export type ChatRef = { repo: string | null; number: number };

/** 状態カードの1行（CI・レビュー・コンフリクト・修復） */
export type ChatTone = "ok" | "warn" | "bad" | "mut";
export type ChatStatusRow = { label: string; value: string; tone: ChatTone };

export type ChatStatusCard = {
  type: "status";
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
  htmlUrl: string | null;
  rows: ChatStatusRow[];
  /** 関連Issue番号（`issue-<番号>`ブランチのPR、またはIssueに紐づくPR） */
  relatedIssue: number | null;
  /** いま「PRを自動修正」を起動した場合に走る種類（空なら修復できる問題なし） */
  repairKinds: RepairKind[];
  session: { label: string; state: string } | null;
};

/** 副作用のある操作の確認カード。**「実行する」の確認APIを通るまで何も走らない** */
export type ChatConfirmCard =
  | {
      type: "confirm_repair";
      repo: string;
      number: number;
      title: string;
      kinds: RepairKind[];
    }
  | {
      type: "confirm_issue";
      repo: string;
      title: string;
      body: string;
    };

export type ChatChoiceCard = {
  type: "choice";
  question: string;
  /** 押すと、その対象を明示した発言として送られる */
  options: { label: string; send: string }[];
};

export type ChatResultCard = {
  type: "result";
  ok: boolean;
  title: string;
  detail: string | null;
  htmlUrl: string | null;
};

export type ChatCard = ChatStatusCard | ChatConfirmCard | ChatChoiceCard | ChatResultCard;

/** 確認カードの状態。押された後は再実行できない（二重実行の防止） */
export type ChatConfirmState = "pending" | "done" | "cancelled";

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: ChatCard[];
  /** 確認カードを含むメッセージだけ。それ以外はnull */
  confirmState: ChatConfirmState | null;
  createdAt: string;
};

// --- チャットセッションの保存・再開（#4047） ---

/** 会話メモの1項目（合意した方針・未解決の質問）。**許可する操作の根拠には使わない**（実行は確認カードだけ） */
export type ChatMemoryItem = {
  id: string;
  text: string;
  createdAt: string;
  /** 未解決の質問を解決済みにしたときだけ付く */
  resolvedAt?: string;
};

/** 状態カードを返した時点の調査結果。再開時に「その時点」と「いま」を区別して見せる材料 */
export type ChatFinding = {
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
  htmlUrl: string | null;
  capturedAt: string;
  rows: ChatStatusRow[];
};

export type ChatMemory = {
  agreements: ChatMemoryItem[];
  openQuestions: ChatMemoryItem[];
  findings: ChatFinding[];
};

export const EMPTY_CHAT_MEMORY: ChatMemory = { agreements: [], openQuestions: [], findings: [] };

/** 再開時に再取得した、いまの状態と調査時点との差 */
export type ChatFreshness = {
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
  capturedAt: string | null;
  /** 調査時点から値が変わった行（調査時点の記録が無ければ空） */
  changes: { label: string; before: string; after: string }[];
  current: ChatStatusRow[];
  error: string | null;
};

export type ChatConversationStatus = "waiting" | "idle";
