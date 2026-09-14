/**
 * develop向けPRのClaudeレビューが「どの条件で走るか」をリポジトリごとに読み取る（#2948）。
 *
 * **なぜ画面に出すか。** `reusable-claude-review-develop.yml`はコスト削減のためゲート付きで
 * （#992）、`claude-review`が走るのは機械的リスク判定（内蔵パターン＋callerの`risk-paths`）に
 * 当たったときか、差分が閾値以上のときなどに限られる。その入力は各リポジトリのcallerに
 * 散らばっており、雛形のままだと**パス名から判別できない領域（認証・トークン処理）に触れる
 * 小さなPRは一度もレビューされない。** ops-dashboard#233では、仕組みがあるのに直近のPRが
 * すべてskipされていたことに、callerを開くまで誰も気づかなかった。
 *
 * ここは純関数だけを置く。取得は`lib/github/review-gates.ts`。
 */

import type { AiReviewState } from "@/lib/github/check-rollup";

/** develop向けレビューのcallerのファイル名（`.github/workflows/`直下） */
export const REVIEW_CALLER_FILE = "claude-review-develop.yml";

/** callerが参照する再利用ワークフロー。これを`uses:`に持たないファイルはcallerとみなさない */
const REUSABLE_WORKFLOW_FILE = "reusable-claude-review-develop.yml";

/**
 * 再利用ワークフロー側の既定値。**`workflow_call.inputs`の`default`と揃える**
 * （`.github/workflows/reusable-claude-review-develop.yml`）。
 */
export const REVIEW_INPUT_DEFAULTS = {
  "review-file-threshold": "10",
  "review-line-threshold": "500",
  "merge-policy": "relaxed",
  "dependency-check": "major",
  "lock-files": "pnpm-lock.yaml package-lock.json",
} as const;

export type ReviewScalarInput = keyof typeof REVIEW_INPUT_DEFAULTS;

/** 再利用ワークフローに内蔵され、callerに書かなくても常に判定されるパターン（表示用） */
export const BUILTIN_RISK_PATTERNS = [
  ".github/workflows/**",
  ".env*",
  ".shared-context/**",
  "prisma/migrations/**",
  "**/auth/**",
] as const;

/** 直近のIssue PRを何件まで数えるか */
export const REVIEW_SAMPLE_SIZE = 20;

export type ReviewInputValue = {
  value: string;
  /** callerの`with:`に書かれているか。偽なら既定値 */
  explicit: boolean;
};

export type RiskPathLine = {
  /** `grep -E`の正規表現 */
  pattern: string;
  /** Issueコメントに出す理由。区切り（` :: `）が無い行は空 */
  reason: string;
  /** 配布雛形の行と一致するか。雛形を取得できなかった場合はnull */
  fromTemplate: boolean | null;
};

/**
 * risk-pathsの状態。
 *
 * - `template`: 雛形の行だけ（固有の行が無い）
 * - `custom`: 雛形の行に加えて固有の行がある
 * - `replaced`: 固有の行はあるが、雛形の行が欠けている
 * - `none`: 入力自体を書いていない（内蔵パターンのみ）
 * - `unknown`: 雛形を取得できず比べられない
 */
export type RiskPathsState = "template" | "custom" | "replaced" | "none" | "unknown";

export type ReviewCallerConfig = {
  inputs: Record<ReviewScalarInput, ReviewInputValue>;
  riskPaths: RiskPathLine[];
  riskPathsState: RiskPathsState;
  /** 固有の行（雛形に無い行）の件数 */
  customRiskPathCount: number;
  /** 雛形にあるのにcallerに無い行の件数 */
  missingTemplateRiskPathCount: number;
};

type WithBlock = {
  scalars: Map<string, string>;
  /** `risk-paths`の生の行（インデントを除いたもの）。書かれていなければnull */
  riskPathsLines: string[] | null;
};

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** `"10"`・`'10'`・`10 # コメント`から値だけを取り出す */
function scalarValue(raw: string): string {
  const value = raw.trim();
  const quoted = /^(["'])(.*)\1\s*(#.*)?$/.exec(value);
  if (quoted) return quoted[2] as string;
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * callerの`with:`を読む。**YAMLとして構文解析せず**、インデントで範囲を切る
 * （`extractWorkflowTagRef`と同じ方針。依存を増やさないため）。
 *
 * 配布雛形とissue-deck本体のcallerが使う書き方（`key: value`と`risk-paths: |`の
 * ブロック）だけを想定している。
 */
function readWithBlock(source: string): WithBlock | null {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*with:\s*(#.*)?$/.test(line));
  if (start < 0) return null;

  const withIndent = indentOf(lines[start] as string);
  const scalars = new Map<string, string>();
  let riskPathsLines: string[] | null = null;

  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent <= withIndent) break;

    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1] as string;
    const rest = (match[2] as string).trim();

    if (/^[|>][-+]?\s*(#.*)?$/.test(rest)) {
      // ブロックスカラー。キーより深いインデントの行が続くかぎり中身
      const block: string[] = [];
      index += 1;
      while (index < lines.length) {
        const inner = lines[index] as string;
        if (inner.trim() !== "" && indentOf(inner) <= indent) break;
        block.push(inner.trim());
        index += 1;
      }
      if (key === "risk-paths") riskPathsLines = block;
      continue;
    }

    if (key === "risk-paths") riskPathsLines = [scalarValue(rest)];
    else scalars.set(key, scalarValue(rest));
    index += 1;
  }

  return { scalars, riskPathsLines };
}

/**
 * risk-pathsの行を`{pattern, reason}`へ分ける。**再利用ワークフローの読み方に揃える**
 * ——空行と`#`で始まる行を読み飛ばし、最初の` :: `で分ける。
 */
export function parseRiskPathLines(lines: string[]): Omit<RiskPathLine, "fromTemplate">[] {
  const result: Omit<RiskPathLine, "fromTemplate">[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf(" :: ");
    if (separator < 0) {
      result.push({ pattern: line, reason: "" });
      continue;
    }
    result.push({
      pattern: line.slice(0, separator).trim(),
      reason: line.slice(separator + 4).trim(),
    });
  }
  return result;
}

/** 本文が develop向けレビューのcaller（再利用ワークフローを`uses:`で呼ぶもの）か */
export function isReviewCaller(source: string): boolean {
  return new RegExp(`^\\s*uses:\\s*\\S*${REUSABLE_WORKFLOW_FILE.replace(/\./g, "\\.")}(@\\S+)?\\s*$`, "m").test(
    source,
  );
}

/** 雛形（`.github/templates/callers/claude-review-develop.yml`）のrisk-pathsの正規表現一覧 */
export function templateRiskPatterns(templateSource: string): string[] {
  const block = readWithBlock(templateSource);
  return parseRiskPathLines(block?.riskPathsLines ?? []).map((line) => line.pattern);
}

/**
 * callerの本文から実行条件を読む。callerでなければnull。
 *
 * `templatePatterns`がnull（雛形を取得できなかった）なら、risk-pathsの状態は`unknown`にする。
 * 空配列を渡すと全行が「固有」に見えてしまうため、区別して受け取る。
 */
export function readReviewCallerConfig(
  source: string,
  templatePatterns: string[] | null,
): ReviewCallerConfig | null {
  if (!isReviewCaller(source)) return null;

  const block = readWithBlock(source);
  const inputs = Object.fromEntries(
    (Object.keys(REVIEW_INPUT_DEFAULTS) as ReviewScalarInput[]).map((key) => {
      const value = block?.scalars.get(key);
      return [
        key,
        value === undefined
          ? { value: REVIEW_INPUT_DEFAULTS[key], explicit: false }
          : { value, explicit: true },
      ];
    }),
  ) as Record<ReviewScalarInput, ReviewInputValue>;

  const template = templatePatterns ? new Set(templatePatterns) : null;
  const riskPaths: RiskPathLine[] = parseRiskPathLines(block?.riskPathsLines ?? []).map((line) => ({
    ...line,
    fromTemplate: template ? template.has(line.pattern) : null,
  }));

  const customRiskPathCount = riskPaths.filter((line) => line.fromTemplate === false).length;
  const present = new Set(riskPaths.map((line) => line.pattern));
  const missingTemplateRiskPathCount = templatePatterns
    ? templatePatterns.filter((pattern) => !present.has(pattern)).length
    : 0;

  return {
    inputs,
    riskPaths,
    riskPathsState: riskPathsState(riskPaths.length, template !== null, customRiskPathCount, missingTemplateRiskPathCount),
    customRiskPathCount,
    missingTemplateRiskPathCount,
  };
}

function riskPathsState(
  total: number,
  hasTemplate: boolean,
  custom: number,
  missingTemplate: number,
): RiskPathsState {
  if (total === 0) return "none";
  if (!hasTemplate) return "unknown";
  if (custom === 0) return "template";
  return missingTemplate > 0 ? "replaced" : "custom";
}

/** 閾値が既定値から変わっているか（明示していても既定と同じなら偽） */
export function isChangedFromDefault(key: ReviewScalarInput, input: ReviewInputValue): boolean {
  return input.explicit && input.value !== REVIEW_INPUT_DEFAULTS[key];
}

/**
 * 1件のPRで`claude-review`がどうなったか。
 *
 * - `reviewed`: 実行し終えた
 * - `skipped`: ゲートで実行されなかった
 * - `error`: `risk-check`が落ちたために実行されなかった（`risk-paths`の書式誤りなど）
 * - `failed`: 実行したが落ちた・新しいpushで打ち切られた
 * - `pending`: まだ終わっていない
 *
 * **`.github/workflows/`を変えるPRは`reviewed`に数えられる。** claude-code-actionの検証機構で
 * Claudeを実行しないまま`success`で終わり、check-runの結論からは見分けられないため。
 */
export type ReviewOutcome = "reviewed" | "skipped" | "error" | "failed" | "pending";

export type ReviewOutcomeItem = {
  number: number;
  url: string;
  outcome: ReviewOutcome;
};

/**
 * PR一覧と同じ判定（`toAiReview`の`AiReviewState`）から結果を決める。`claude-review`の
 * check-runが無ければnull（draftのまま・callerが入る前のPRなど。**数えない**）。
 */
export function reviewOutcomeOf(aiReview: AiReviewState, riskCheckFailed: boolean): ReviewOutcome | null {
  switch (aiReview) {
    case "none":
      return null;
    case "pending":
      return "pending";
    case "passed":
      return "reviewed";
    case "failed":
      return "failed";
    case "skipped":
      return riskCheckFailed ? "error" : "skipped";
  }
}

/**
 * 数える対象のPRか。**`issue-<番号>`ブランチだけ**を数える。
 *
 * `release/`・`workflow-tag/`のようにIssue番号を特定できないPRは、ゲートの条件
 * （対応Issue番号不明）で常にレビューされるため、含めると割合が実態より高く見える。
 */
export function isIssueBranch(headRefName: string): boolean {
  return /^issue-\d+$/.test(headRefName);
}

export type ReviewOutcomeSummary = {
  reviewed: number;
  skipped: number;
  errors: number;
  counted: number;
};

/**
 * 実行・skipの件数。分母は実行とskipだけで、判定エラー・失敗・打ち切り・実行中は入れない
 * （ゲートの効き方を見たいので、ゲートまで届かなかったPRを混ぜない）。判定エラーは別に数える。
 */
export function summarizeReviewOutcomes(items: ReviewOutcomeItem[]): ReviewOutcomeSummary {
  const count = (outcome: ReviewOutcome) => items.filter((item) => item.outcome === outcome).length;
  const reviewed = count("reviewed");
  const skipped = count("skipped");
  return { reviewed, skipped, errors: count("error"), counted: reviewed + skipped };
}

const STATE_ORDER: Record<RiskPathsState, number> = {
  template: 0,
  unknown: 1,
  replaced: 2,
  custom: 3,
  none: 4,
};

/** 注意の要るもの（雛形のまま）を先頭に、同じ状態の中は名前順に並べる */
export function sortByRiskPathsState<T extends { fullName: string; config: ReviewCallerConfig }>(
  repositories: T[],
): T[] {
  return [...repositories].sort(
    (a, b) =>
      STATE_ORDER[a.config.riskPathsState] - STATE_ORDER[b.config.riskPathsState] ||
      a.fullName.localeCompare(b.fullName),
  );
}
