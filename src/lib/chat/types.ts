import type { RepairKind } from "@/lib/github/pull-request-repair";

/** 修正依頼の種類。`code`はPRのブランチへのpush、`metadata`はPR本文・Issue本文の追跡情報だけ（pushしない） */
export type FixRequestScopeKind = "code" | "metadata";

/** 会話が指している1件（Issue・PRは同じ番号空間なので、取得してから種別が決まる） */
export type ChatTarget = {
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
};

/** 実行（または確認待ち）にした操作の記録。会話コンテキストの`actions`に積む */
export type ChatActionRecord = {
  type: "repair" | "create_issue" | "fix_request";
  status: "started" | "created" | "failed";
  repo: string;
  number: number | null;
  at: string;
  message: string;
  /** 修正依頼（`fix_request`）だけ。依頼した時点のHEADと、依頼コメントのURL・紐づくIssue（#4045） */
  fixRequest?: {
    headSha: string;
    commentUrl: string | null;
    issueNumber: number;
    /** 修正の種類。省略は`code`（#4153） */
    scope?: FixRequestScopeKind;
    /** 依頼時点のレビュー判定（`metadata`の検証で「元の指摘が解消したか」を見る材料） */
    reviewKindBefore?: string | null;
  };
};

/** 調査で確かめた根拠1件。回答の「根拠」欄へリンクと取得時点つきで出す（#4045） */
export type ChatEvidence = {
  label: string;
  url: string | null;
  /** 取得した時点（ISO8601） */
  fetchedAt: string;
  /** PRのHEAD・実行IDなど、「何を見たか」を特定する値 */
  ref: string | null;
};

/**
 * 調査の引き継ぎ（#4045）。「それ」「この方針で」「続けて」が指す材料で、会話コンテキストと一緒に保存する。
 * 方針の質問に答えると、ここから元の対象・調査を保ったまま再開する。
 */
export type ChatInvestigation = {
  target: ChatTarget | null;
  /** 直近の調査で言えたこと（事実・推測・未確認を区別した要約） */
  summary: string;
  evidence: ChatEvidence[];
  /** 会話で合意した方針・条件 */
  agreements: string[];
  /** 利用者の判断待ち・未解決の事項 */
  openQuestions: string[];
  /** 取得できなかった・上限で見られなかった範囲 */
  unconfirmed: string[];
  updatedAt: string;
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
  /** 直近の調査の引き継ぎ（#4045）。無ければnull */
  investigation?: ChatInvestigation | null;
};

export const EMPTY_CHAT_CONTEXT: ChatContext = { repo: null, targets: [], actions: [], investigation: null };

/** 文章から読み取った意図。**実行はせず**、解決（`resolveIntent`）と確認を経る */
export type ChatIntent =
  | { type: "status"; refs: ChatRef[] }
  | { type: "recheck" }
  | { type: "merge_check" }
  | { type: "repair"; ref: ChatRef | null }
  | { type: "create_issue"; title: string | null }
  /** 状態の言い換えでは答えられない質問・依頼。AIが読み取り専用ツールで調べて答える（#4045） */
  | { type: "investigate"; ref: ChatRef | null; fix?: boolean; request?: boolean }
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
      /** 起案前に見つかった、同じ話題の既存Issue（重複確認。#4045） */
      duplicates?: { number: number; title: string; htmlUrl: string; state: string }[];
    }
  | {
      /** 合意した方針で同じPRを直すよう、紐づくIssueへ依頼を渡す（#4045）。実行系は既存の`@claude`経路 */
      type: "confirm_fix_request";
      repo: string;
      number: number;
      title: string;
      /** 依頼を組み立てた時点のHEAD。実行時に変わっていたら中断する */
      headSha: string;
      issueNumber: number;
      /** 実行系へ渡す依頼本文（合意した方針・未解消の指摘・検証条件） */
      instruction: string;
      /** 修正の種類。省略は`code`（#4153） */
      scope?: FixRequestScopeKind;
      /** 調査時点のPR本文のハッシュ。`metadata`で、実行時に本文が変わっていたら中断する */
      prBodyHash?: string;
      /** 調査時点のレビュー判定（`ok` / `changes-requested`など） */
      reviewKindBefore?: string | null;
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

/** 調査結果の根拠欄（#4045）。事実／推測／未確認を分けて出す */
export type ChatInvestigationCard = {
  type: "investigation";
  evidence: ChatEvidence[];
  facts: string[];
  inferences: string[];
  unconfirmed: string[];
  /** 打ち切った理由（上限到達・進展なし等）。完走したらnull */
  stopReason: string | null;
};

/** 修正依頼の進み具合（#4045）。CI／レビュー待ちは完了にしない */
export type ChatFixProgressCard = {
  type: "fix_progress";
  repo: string;
  number: number;
  phase: "requested" | "working" | "waiting_ci" | "waiting_review" | "verified" | "failed";
  phaseLabel: string;
  headSha: string | null;
  requestedHeadSha: string;
  steps: { label: string; done: boolean; note: string | null }[];
  htmlUrl: string | null;
  fetchedAt: string;
};

export type ChatCard =
  | ChatStatusCard
  | ChatConfirmCard
  | ChatChoiceCard
  | ChatResultCard
  | ChatInvestigationCard
  | ChatFixProgressCard;

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

/**
 * サブPCのCodex CLIで回答を作っている途中の発言（#4109）。`provider`は実際に使った実行先
 * （`codex-cli`）で、OpenAI APIの利用と区別して画面・診断に出す。
 */
export type ChatRunView = {
  id: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  phase: string;
  provider: string;
  model: string | null;
  failureKind: string | null;
  userMessageId: string;
  assistantMessageId: string | null;
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
