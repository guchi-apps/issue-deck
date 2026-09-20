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

// 次枠実行（#2995）で起動を始める「5時間枠の残り時間」（分）。**枠の終わり際に寄せる値だけ**を
// 並べる——2時間より手前を選べるようにすると「いまの枠で実行する」のと変わらなくなり、枠を
// またいで次の枠を起こすという目的から外れる。
export const NEXT_WINDOW_RUN_LEAD_MINUTES_OPTIONS = [30, 45, 60, 90, 120] as const;
export const NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT = 60;

export function parseNextWindowRunLeadMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return (NEXT_WINDOW_RUN_LEAD_MINUTES_OPTIONS as readonly number[]).includes(value) ? value : null;
}

// 1件起動してから次を起動するまで空ける時間（分）。**0を残してある**のは、1件しか積まない
// 使い方で待たされないようにするため。既定の10分は、枠が開いてから60分のあいだに6件まで
// という見当。
export const NEXT_WINDOW_RUN_INTERVAL_MINUTES_OPTIONS = [0, 5, 10, 15, 30] as const;
export const NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT = 10;

export function parseNextWindowRunIntervalMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return (NEXT_WINDOW_RUN_INTERVAL_MINUTES_OPTIONS as readonly number[]).includes(value)
    ? value
    : null;
}

// 次枠実行で起動しない「残り枠の下限」（%・#3100）。**残りがこの値を下回っている間は起動を見送る**。
// 0は制限しない（既定。従来と同じ動き）。自由入力にしないのは、100のような値で無人実行が
// 永久に止まるのを避けるため（上限は半分に留める）。5時間枠・週間枠で同じ選択肢を使う。
export const NEXT_WINDOW_RUN_FLOOR_PERCENT_OPTIONS = [0, 10, 20, 30, 40, 50] as const;
export const NEXT_WINDOW_RUN_FLOOR_PERCENT_DEFAULT = 0;

export function parseNextWindowRunFloorPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return (NEXT_WINDOW_RUN_FLOOR_PERCENT_OPTIONS as readonly number[]).includes(value)
    ? value
    : null;
}

// 5時間枠を開けておく（#3032）時間帯の開始・終了（日本時間の時）。既定は7:00〜23:00——夜間は
// 開けない（寝ている間の枠は次枠実行で使うほうが得なため）。
export const CLAUDE_WINDOW_KEEPALIVE_START_HOUR_DEFAULT = 7;
export const CLAUDE_WINDOW_KEEPALIVE_END_HOUR_DEFAULT = 23;

export function parseClaudeWindowKeepAliveHour(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value <= 23 ? value : null;
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
 * 短いのはチップの幅が3列で110px前後しかないため。選んだあとの説明文は出さない（#3119。
 * ダイアログを1画面に収めるためで、この2行目と重複していた）。
 */
export const CLAUDE_MODEL_FIT_LABELS: Readonly<Record<ClaudeModel, string>> = {
  auto: "Claude Codeに任せる",
  fable: "難しい調査・設計から",
  opus: "調査・設計判断あり",
  sonnet: "仕様が決まった実装",
  haiku: "文言修正・定型作業",
};

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseClaudeModel(value: unknown): ClaudeModel | null {
  if (typeof value !== "string") return null;
  return (CLAUDE_MODEL_VALUES as readonly string[]).includes(value) ? (value as ClaudeModel) : null;
}

/**
 * ローカルセッション（サブPCで新しく起動するClaude Codeセッション）で使えるモデルの候補（#2756・#2776）。
 * **`haiku`と`auto`を含まない。**
 *
 * - `haiku`: ローカルセッションは`--permission-mode auto`で起動しており
 *   （`run-issue-session.sh`・`start-issue.sh`）、Haikuはauto modeで動作しないため選ばせない
 *   （https://github.com/anthropics/claude-code/issues/43235）。
 * - `auto`（CLIの既定。`--model`を付けずClaude Code側の設定・アカウントの既定に委ねる）は
 *   #2776で選択肢から外した。「どのモデルで動くか分からない」まま起動できる方式自体が不要
 *   というIssueの要求に加え、`auto`を選べる状態を残すと、`scripts/run-issue-session.sh`の
 *   受付コメント用フォールバック（`ISSUE_DECK_CLAUDE_MODEL`が空のときだけGitHub Actions向け
 *   設定`claudeModel`を代わりに読む処理）との食い違いが表に出やすかった。**この関数の戻り値が
 *   常にfable/opus/sonnetのいずれかになったことで、その食い違いも実質発生しなくなる**
 *   （その処理自体は今回変更していない）。
 *
 * GitHub Actions向け（`claudeModel`・`claudeModelAssist`）は`--allowedTools`での許可制で
 * auto modeを使わないため対象外——`CLAUDE_MODEL_OPTIONS`のまま`auto`・`haiku`を選べる。
 */
export const CLAUDE_LOCAL_MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS.filter(
  (option) => option.value !== "haiku" && option.value !== "auto",
);

export const CLAUDE_LOCAL_MODEL_VALUES = CLAUDE_LOCAL_MODEL_OPTIONS.map((option) => option.value);

export type ClaudeLocalModel = (typeof CLAUDE_LOCAL_MODEL_VALUES)[number];

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
// `claudeLocalModel`設定・Issueごとのローカル起動モデル指定（`POST /api/dispatch`）の
// バリデーションに使う。`haiku`はここで弾かれ、既存にHaikuが保存されていてもnullへ落ちて
// 呼び出し側の既定（`CLAUDE_LOCAL_MODEL_DEFAULT`）へフォールバックする。
export function parseClaudeLocalModel(value: unknown): ClaudeLocalModel | null {
  if (typeof value !== "string") return null;
  return (CLAUDE_LOCAL_MODEL_VALUES as readonly string[]).includes(value)
    ? (value as ClaudeLocalModel)
    : null;
}

/**
 * 「おまかせ」（Issueの内容からissue-deckがモデルを選ぶ）を表す設定値（#3106）。
 * 「実装を開始」ダイアログの`AUTO_PICK`と同じ文字列で、**`ClaudeModel`ではない**。
 *
 * `AppSetting.claudeLocalModel`にだけ入り、ジョブ（`DispatchJob.claudeModel`）・APIの`model`・
 * pollerへ渡る値には入らない（判定が終わった具体的なモデル名へ解決してから積む）。
 * そのため`parseClaudeLocalModel`はこの値を弾いたままにしてある。
 */
export const MODEL_PICK_SETTING = "pick" as const;

/**
 * 設定「サブPC（Claude）：計画・実装」の候補（#3106）。先頭に「おまかせ」を足した4つで、
 * 「実装を開始」ダイアログの最初の選択になる。
 */
export const CLAUDE_LOCAL_MODEL_SETTING_OPTIONS = [
  { value: MODEL_PICK_SETTING, label: "おまかせ（Issueの内容から選ぶ）" },
  ...CLAUDE_LOCAL_MODEL_OPTIONS,
] as const;

export type ClaudeLocalModelSetting = ClaudeLocalModel | typeof MODEL_PICK_SETTING;

// `claudeLocalModel`設定の検証（設定の読み書き・画面へ渡す値）。ジョブ・APIの`model`には
// `parseClaudeLocalModel`を使う——そちらは`pick`を通さない。
export function parseClaudeLocalModelSetting(value: unknown): ClaudeLocalModelSetting | null {
  return value === MODEL_PICK_SETTING ? MODEL_PICK_SETTING : parseClaudeLocalModel(value);
}

// Codex CLI起動時の`-m`へ渡す候補（#2550）。"auto"は`-m`を付与しない特別な値。
export const CODEX_MODEL_OPTIONS = [
  { value: "auto", label: "Codexに任せる" },
  { value: "gpt-6-astra", label: "GPT-6 Astra（最高精度）" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol（高精度）" },
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

/**
 * 「実装を開始」ダイアログで選べるCodexのモデル（#3192）。**重い順。**
 * 「おまかせ」の判定候補（`lib/claude/model-pick.ts`）も同じ4つ（Astra・Sol・Terra・Luna）。
 *
 * `auto`（`-m`を付けない起動）と旧世代（GPT-5.5・5.4）は入れない。どのモデルで立つか分からない
 * 方式は、Claude側で選択肢から外したのと同じ理由（#2776）で選ばせない。設定
 * （`AppSetting.codexModel`）には従来どおり残り、ダイアログを経由しない起動が読む。
 * 値は`CODEX_MODEL_OPTIONS`の部分集合なので、選んだものはそのまま`-m`へ渡せる。
 */
export const CODEX_LOCAL_MODEL_VALUES = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export type CodexLocalModel = (typeof CODEX_LOCAL_MODEL_VALUES)[number];

// ジョブ・APIの`model`の検証（`parseClaudeLocalModel`のCodex版）。`pick`（おまかせ）は通さない。
export function parseCodexLocalModel(value: unknown): CodexLocalModel | null {
  if (typeof value !== "string") return null;
  return (CODEX_LOCAL_MODEL_VALUES as readonly string[]).includes(value)
    ? (value as CodexLocalModel)
    : null;
}

/** 狭い場所（起動ダイアログのチップ・実行キューの印）に出す短い名前 */
export const CODEX_MODEL_SHORT_LABELS: Readonly<Record<CodexModel, string>> = {
  auto: "CLIの既定",
  "gpt-6-astra": "Astra",
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
  "gpt-5.6-luna": "Luna",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
};

export function describeCodexModel(model: CodexModel): string {
  return CODEX_MODEL_SHORT_LABELS[model];
}

/** モデルごとの「向いている作業」（`CLAUDE_MODEL_FIT_LABELS`と同じ位置づけ。チップの2行目） */
export const CODEX_MODEL_FIT_LABELS: Readonly<Record<CodexLocalModel, string>> = {
  "gpt-6-astra": "未知の調査・設計から",
  "gpt-5.6-sol": "難しい調査・実装",
  "gpt-5.6-terra": "仕様が決まった実装",
  "gpt-5.6-luna": "文言修正・定型作業",
};

/**
 * 設定「Codex：サブPCでの計画・実装」の候補（#3192）。先頭に「おまかせ」を足したもので、
 * 「実装を開始」ダイアログの最初の選択になる（`CLAUDE_LOCAL_MODEL_SETTING_OPTIONS`のCodex版）。
 */
export const CODEX_MODEL_SETTING_OPTIONS = [
  { value: MODEL_PICK_SETTING, label: "おまかせ（Issueの内容から選ぶ）" },
  ...CODEX_MODEL_OPTIONS,
] as const;

export type CodexModelSetting = CodexModel | typeof MODEL_PICK_SETTING;

// `codexModel`設定の検証（設定の読み書き・画面へ渡す値）。ジョブ・APIの`model`には
// `parseCodexLocalModel`を使い、`pick`は通さない。払い出し（claim）も同じく`parseCodexModel`が
// `pick`を弾いて既定（Terra）へ落とす——判定はダイアログだけが行う。
export function parseCodexModelSetting(value: unknown): CodexModelSetting | null {
  return value === MODEL_PICK_SETTING ? MODEL_PICK_SETTING : parseCodexModel(value);
}

/**
 * ダイアログを開いたときのCodexモデルの初期選択。設定が「おまかせ」ならそれ、選べる3つのどれかなら
 * その値、それ以外（`auto`・旧世代）は既定（Terra）。旧世代・`auto`はダイアログの候補に無く、
 * 選択なしのまま開くとどれで立つのかが分からなくなるため。
 */
export function resolveCodexInitialModel(
  setting: CodexModelSetting,
): CodexLocalModel | typeof MODEL_PICK_SETTING {
  if (setting === MODEL_PICK_SETTING) return MODEL_PICK_SETTING;
  return parseCodexLocalModel(setting) ?? CODEX_MODEL_DEFAULT;
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

/**
 * 「おまかせ」（モデルの自動選択）の判定に使うAI（#3189）。
 *
 * **モデルを選ぶ側のAIであって、選ばれる側ではない。** 選ばれるのは今までどおり
 * `MODEL_PICK_CANDIDATES`（sonnet・opus・fable）で、ここはその判定を誰にさせるかの設定。
 *
 * `jev`はTypeSafeのSystem Oneモデルで、**文章を書かず候補から1つと確率だけを返す**。
 * 候補外の答えが構造上返らないぶん、応答を読めずにルールへ倒れることが無くなる。
 * ただし`TYPESAFE_API_KEY`が要るため、**未設定・呼び出し失敗のときは`app-ai`と同じ経路へ倒す**。
 */
export const MODEL_PICK_ENGINE_OPTIONS = [
  { value: "app-ai", label: "アプリ内AIのモデルに従う" },
  { value: "jev", label: "Jev（TypeSafe・判定専用／高速・低コスト）" },
] as const;

export const MODEL_PICK_ENGINE_DEFAULT = MODEL_PICK_ENGINE_OPTIONS[0].value;
export const MODEL_PICK_ENGINE_VALUES = MODEL_PICK_ENGINE_OPTIONS.map((option) => option.value);
export type ModelPickEngine = (typeof MODEL_PICK_ENGINE_VALUES)[number];

export function parseModelPickEngine(value: unknown): ModelPickEngine | null {
  if (typeof value !== "string") return null;
  return (MODEL_PICK_ENGINE_VALUES as readonly string[]).includes(value)
    ? (value as ModelPickEngine)
    : null;
}
