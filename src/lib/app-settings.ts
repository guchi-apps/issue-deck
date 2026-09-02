export const AUTO_RETRY_LIMIT_MIN = 0;
export const AUTO_RETRY_LIMIT_MAX = 10;

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseAutoRetryLimit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < AUTO_RETRY_LIMIT_MIN || value > AUTO_RETRY_LIMIT_MAX) return null;
  return value;
}

// サブPCへディスパッチしたジョブの同時実行数の上限（#1179）。**定数で埋め込まない**という
// 決めごと（#1176）があるためAppSettingに持つ。CPUの載せ替えで適正値が変わる。
//
// 既定の3は**Ryzen 5 PRO 4650G（6C/12T）での実測**（guchi-apps/subpc#19・#1812）による。
// 3本の同時ビルドでピーク8.36GiB・swap 0、CPUの合計使用率は753%で12スレッド（1200%）に対して
// まだ頭打ちしていない。4本目は10.61GiBでswapへ3.0GiB落ち、ビルド所要が39.0秒→85.6秒（2.2倍）
// に伸びるため、上限は3本。**先に尽きるのはCPUではなくメモリ**（13Gi・載せ替えでは変わらず）。
//
// 旧既定の2は**Athlon 200GE（2C/4T）だった頃の実測**（#1177）で、`next build`単体が4スレッド中
// 2.6を使い切るCPU律速を避けるための値だった。載せ替えでその律速が消えたため3へ上げた（#1812）。
// 上限の8は、載せ替えを見込んで先に取ってあった余裕（載せ替え後も据え置き）。
export const DISPATCH_CONCURRENCY_MIN = 1;
export const DISPATCH_CONCURRENCY_MAX = 8;
export const DISPATCH_CONCURRENCY_DEFAULT = 3;

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
export function parseDispatchConcurrency(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < DISPATCH_CONCURRENCY_MIN || value > DISPATCH_CONCURRENCY_MAX) return null;
  return value;
}

// 参照されていない添付画像を自動でゴミ箱へ移すまでの日数（#2475）。
//
// 既定の30日は**下書きの猶予**として決めている。投稿前の下書きはブラウザのlocalStorageに
// しか無く（`use-issue-draft.ts`）、サーバーからは「参照されていない画像」と区別が付かない。
// 短くすると、書きかけのIssueに貼った画像が投稿前に消える。
//
// 選べる値を絞っているのは、ここが**取り消しの効かない処理の唯一のつまみ**だから。
// 自由入力にして1日などを入れられるようにする必要が無い。
export const IMAGE_RETENTION_DAYS_OPTIONS = [7, 30, 90, 180] as const;
export const IMAGE_RETENTION_DAYS_DEFAULT = 30;

export function parseImageRetentionDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return (IMAGE_RETENTION_DAYS_OPTIONS as readonly number[]).includes(value) ? value : null;
}

// claude-issue-dispatch.ymlがclaude-code-action起動時に付与する--modelの候補値（#622）。
// "auto"は--modelを付与しない特別な値。それ以外はClaude Code CLIが解釈するモデルエイリアス
// （最新のOpus/Sonnet/Haikuに解決される）で、特定のスナップショット日付は含めない
// （固定すると将来のモデル更新を自動で受けられなくなるため）。
export const CLAUDE_MODEL_OPTIONS = [
  { value: "auto", label: "Claude Codeに任せる" },
  { value: "fable", label: "Claude Fable（最高精度）" },
  { value: "opus", label: "Claude Opus（高精度）" },
  { value: "sonnet", label: "Claude Sonnet（標準）" },
  { value: "haiku", label: "Claude Haiku（高速）" },
] as const;

export const CLAUDE_MODEL_VALUES = CLAUDE_MODEL_OPTIONS.map((option) => option.value);
export const CLAUDE_LOCAL_MODEL_DEFAULT = "sonnet" as const;

export type ClaudeModel = (typeof CLAUDE_MODEL_VALUES)[number];

/**
 * 狭い場所（起動ダイアログのチップ・実行キューの印）に出す短い名前（#2717）。
 * `CLAUDE_MODEL_OPTIONS`のラベルはセレクト向けで、3列に並べると入らない。
 *
 * **`auto`は「おまかせ」ではなく「CLIの既定」**（#2723）。実体は`--model`を付けないことで、
 * どのモデルで立つかはClaude Code側の設定・アカウントの既定で決まる——**作業の内容に応じて
 * 選ばれるわけではない**のに「おまかせ」は賢く選ぶように読める。受付コメント
 * （`lib/dispatch/session-start.ts`）が先に使っていた呼び方へ揃えた。「おまかせ」の名前は、
 * issue-deckがIssueを読んで選ぶ起動ダイアログの選択肢（`lib/claude/model-pick.ts`）が引き継ぐ。
 */
export const CLAUDE_MODEL_SHORT_LABELS: Readonly<Record<ClaudeModel, string>> = {
  auto: "CLIの既定",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export function describeClaudeModel(model: ClaudeModel): string {
  return CLAUDE_MODEL_SHORT_LABELS[model];
}

/**
 * モデルごとの「向いている作業」（#2723）。**起動ダイアログのチップの2行目に出す。**
 *
 * 以前はここに1件あたりの目安金額を出していたが、1回ぶんなのか実費なのかが画面から決まらず、
 * しかも費用の6割強がキャッシュ読み出しのため FableとOpusがほぼ並び、見比べても選べなかった。
 * **選ぶ基準は作業の重さ**なので、そちらを持たせる。実績の金額は「AI使用量」の画面で見る。
 *
 * 短いのはチップの幅が2列で172px前後しかないため。**判断の背景は`CLAUDE_MODEL_FIT_DESCRIPTIONS`**
 * （選んだときにグリッドの下へ出す一行）に置く。
 */
export const CLAUDE_MODEL_FIT_LABELS: Readonly<Record<ClaudeModel, string>> = {
  auto: "Claude Codeに任せる",
  fable: "難しい調査・設計から",
  opus: "調査・設計判断あり",
  sonnet: "仕様が決まった実装",
  haiku: "文言修正・定型作業",
};

/** 選んだモデルの説明（#2723）。グリッドの下に1行で出す */
export const CLAUDE_MODEL_FIT_DESCRIPTIONS: Readonly<Record<ClaudeModel, string>> = {
  auto: "モデルを指定せずに起動します（--modelを付けません）。どのモデルで立つかはClaude Code側の設定・アカウントの既定で決まり、作業の内容では選ばれません。実際に動いたモデルはセッションの表示に出ます。",
  fable: "原因が読めない不具合や、設計から考える実装に向きます。",
  opus: "既存の作りを調べたうえで判断が要る実装に向きます。",
  sonnet: "やることがはっきりしている実装に向きます。",
  haiku: "判断の少ない小さな修正や、決まった形の追記に向きます。",
};

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseClaudeModel(value: unknown): ClaudeModel | null {
  if (typeof value !== "string") return null;
  return (CLAUDE_MODEL_VALUES as readonly string[]).includes(value) ? (value as ClaudeModel) : null;
}

// Codex CLI起動時の`-m`へ渡す候補（#2550）。"auto"は`-m`を付与しない特別な値。
export const CODEX_MODEL_OPTIONS = [
  { value: "auto", label: "Codexに任せる" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol（最高精度）" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra（標準）" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna（高速）" },
  { value: "gpt-5.5", label: "GPT-5.5（旧世代）" },
  { value: "gpt-5.4", label: "GPT-5.4（旧世代）" },
] as const;

export const CODEX_MODEL_DEFAULT = "gpt-5.6-terra" as const;

export const CODEX_MODEL_VALUES = CODEX_MODEL_OPTIONS.map((option) => option.value);
export type CodexModel = (typeof CODEX_MODEL_VALUES)[number];

export function parseCodexModel(value: unknown): CodexModel | null {
  if (typeof value !== "string") return null;
  return (CODEX_MODEL_VALUES as readonly string[]).includes(value) ? (value as CodexModel) : null;
}

// アプリ内の要約・検索・文章整理など、Anthropic APIを直接呼ぶ機能で使うモデル（#2562）。
// スナップショット日付を固定せず、同じモデル系列の更新を自動で受けられるエイリアスを使う。
export const APP_AI_MODEL_OPTIONS = [
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5（高速）" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5（標準）" },
  { value: "claude-opus-5", label: "Claude Opus 5（高精度）" },
  // Fable 5.1は単価がSonnet 5の5倍（入力$10 / 出力$50）。**1往復で終わる要約・検索では
  // キャッシュが効かず倍率がそのまま効く**ので、選ぶのは判断力が要る用途（原因診断・
  // 新規アプリの相談）に限る想定（#2717）
  { value: "claude-fable-5-1", label: "Claude Fable 5.1（最高精度）" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol（最高精度）" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra（標準）" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna（高速）" },
] as const;

export const APP_AI_MODEL_DEFAULT = APP_AI_MODEL_OPTIONS[0].value;
export const APP_AI_MODEL_REASONING_DEFAULT = "claude-sonnet-5" as const;
export const APP_AI_MODEL_VALUES = APP_AI_MODEL_OPTIONS.map((option) => option.value);
export type AppAiModel = (typeof APP_AI_MODEL_VALUES)[number];
export type AppAiProvider = "anthropic" | "openai";

export function appAiProvider(model: AppAiModel): AppAiProvider {
  return model.startsWith("gpt-") ? "openai" : "anthropic";
}

export function parseAppAiModel(value: unknown): AppAiModel | null {
  if (typeof value !== "string") return null;
  return (APP_AI_MODEL_VALUES as readonly string[]).includes(value)
    ? (value as AppAiModel)
    : null;
}
