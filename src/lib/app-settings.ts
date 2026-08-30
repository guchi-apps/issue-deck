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
  { value: "auto", label: "自動" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
] as const;

export const CLAUDE_MODEL_VALUES = CLAUDE_MODEL_OPTIONS.map((option) => option.value);

export type ClaudeModel = (typeof CLAUDE_MODEL_VALUES)[number];

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseClaudeModel(value: unknown): ClaudeModel | null {
  if (typeof value !== "string") return null;
  return (CLAUDE_MODEL_VALUES as readonly string[]).includes(value) ? (value as ClaudeModel) : null;
}

// Codex CLI起動時の`-m`へ渡す候補（#2550）。"auto"は`-m`を付与しない特別な値。
export const CODEX_MODEL_OPTIONS = [
  { value: "auto", label: "自動" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
] as const;

export const CODEX_MODEL_VALUES = CODEX_MODEL_OPTIONS.map((option) => option.value);
export type CodexModel = (typeof CODEX_MODEL_VALUES)[number];

export function parseCodexModel(value: unknown): CodexModel | null {
  if (typeof value !== "string") return null;
  return (CODEX_MODEL_VALUES as readonly string[]).includes(value) ? (value as CodexModel) : null;
}
