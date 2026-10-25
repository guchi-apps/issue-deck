# アプリ内AIをCodex CLIで動かす（#5067）

IssueDeckのアプリ内AI（要約・類似Issue検索・本文整理・Issue作成補助など）は、設定でモデルを選ぶだけで
**実行先を手動で切り替えられる**。自動切替はしない。

| 設定で選んだモデル | 実行先 | 課金・枠 |
|---|---|---|
| Claude系（既定） | IssueDeckサーバー → Anthropic API | Claudeのサブスク枠（`CLAUDE_CODE_OAUTH_TOKEN`） |
| GPT系 | サブPCのログイン済みCodex CLI | ChatGPTのサブスク枠。**OpenAI API（`OPENAI_API_KEY`・従量課金）は使わない** |

Claudeが使えないときは、設定画面の「アプリ内AI：要約・検索・文章整理」（と、必要なら「原因診断・新規アプリ相談」）を
GPT系へ切り替える。Claudeのトークンが無くても動く。

## 仕組み

- 振り分けの正は`src/lib/claude/request.ts`の`routeAppAi`。共通入口`callClaudeMessages`がGPT系を見たら
  `src/lib/claude/app-ai-codex.ts`の`runAppAiOnCodex`へ渡し、呼び出し元にはClaude形の応答（`content[0].text`）を返す。
  呼び出し元（各機能）はどちらの経路かを意識しない
- 受け渡しはチャット調査と同じ`CHAT_TURN`ジョブ（[chat.md](chat.md)）。プロンプトと結果は`AppAiCodexRun`に置き、
  受け口（`src/lib/chat/codex-turn-report.ts`）がジョブIDから`ChatRun`か`AppAiCodexRun`のどちらかを引く。
  サブPC側は`scripts/run-chat-codex.sh`の単発実行（`mode`無し）で動き、**サブPC側のスクリプト変更は無い**
- 自由文の機能は`{"text": ...}`1欄のスキーマで包んで受け取り、外してから返す。`output_config`のjson_schemaを
  使う機能はそのスキーマを渡す（Codexの制約に合わせ、全項目required・`additionalProperties: false`へ正規化する。
  任意だった項目はnullを許す）
- サーバーはDBを1秒おきに見て待つ。上限は呼び出し元の`timeoutMs`（無ければ180秒）。30秒受け取られない・上限を過ぎた
  ときはジョブを取り消し、遅れて届いた結果は捨てる
- 使用量は呼び出した機能のまま、モデルを`codex-cli/<モデル>`として記録する（Claude系・OpenAI APIの`gpt-*`と混ざらない）

## 失敗の扱い

失敗は`AppAiCodexError`として投げ、**ClaudeにもOpenAI APIにも切り替えない**。各画面は次の原因を区別して表示する
（文言の末尾に「Claudeへは切り替えていません」が付く）。

サブPCがオフライン／pollerが未対応／サブPCが受け取らない／Codex CLI未ログイン／APIキーでのログイン（従量課金になるため拒否）／
ChatGPTサブスクの利用枠超過／時間切れ／応答を読み取れない／Codexの実行失敗／画像入力は未対応

## 機能ごとの実行先とClaude停止時の可否

| 機能 | GPT系を選んだときの実行先 | Claude停止時 |
|---|---|---|
| コメントの要約 | Codex CLI | 使える |
| AI検索（類似Issue検索） | Codex CLI | 使える |
| 本文の整形 | Codex CLI | 使える |
| Issueの下書き提案・作成後のタイトル補完 | Codex CLI | 使える |
| デプロイ失敗の原因分析 | Codex CLI | 使える |
| 手作業Issueの本文修復（実行開始時） | Codex CLI（上限60秒） | 使える |
| 手作業の修正提案（推論側） | Codex CLI | 使える |
| 新規アプリの相談（推論側） | Codex CLI | 使える |
| 全体レビューの判断の推奨（推論側） | Codex CLI（上限90秒） | 使える |
| 原因診断（チャット調査） | 既存のCodex経路（#4143） | 使える |
| 画像からの変更内容の抽出 | **対象外**（Codex経路は画像入力に未対応。エラーを表示。後続 #5068） | 使えない |
| モデルの自動選択 | Codexを呼ばずルールで判定（起動ダイアログを待たせないため） | ルール判定で動く |
| プラン枠メーター（5時間・週間） | Claude固定（Claudeの枠そのものを測るため） | 測れない |
| 計画レビューの採否判定・Jevでの判定 | 対象外（TypeSafeのJevで動く） | Jev次第 |

「並び替え」（着手順の提案）は#3294で機能ごと削除済みで、現行コードに対象は無い（使用量の記録名`issue_order`だけが残っている）。
