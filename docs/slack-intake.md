# Slackからのissue起案（#4454）

Slackの`#アプリissue起案`への投稿から、対象リポジトリを**利用者がSlack上で選んで**Issueを起案し、結果をIssueDeckのbot名義・依頼者メンション付きで同じスレッドへ返す。調査・重複確認・Issue案づくりは既存のIssueDeck Chat（[chat.md](chat.md)）を呼ぶだけで、判定は複製していない。

## 流れと責任境界

```text
投稿 → POST /api/slack/events（署名検証→event_idで再送除外→即ack→非同期）
  └ 新規の親投稿: SlackIntakeRequest作成 → 👀 → 対象選択UI（static_select／候補が100超はexternal_select）
       └ 「この対象で起案する」: 権限を確かめ、確定したowner/repoで調査・重複確認（handleChatMessage）
            └ Issue案＋「この案で起案する」ボタン（⚠️＝確認待ち）。**押すまでIssueは作らない**
                 └ 押下: confirmStateをpending→doneにできた1回だけexecuteConfirmedCard → ✅＋Issueリンク
  └ スレッド返信（依頼者本人のみ）: お礼→何もしない／質問→同じスレッドで回答／補足→既存Issueへコメント追記／
       「別件」と明示→分割案（相互リンク）／Issue未作成の間の返信→材料に足して案を作り直す
```

| 担当 | 場所 |
|---|---|
| イベント受付・署名検証・許可判定・冪等性・Slack投稿 | IssueDeck（`src/lib/slack/`・`src/app/api/slack/`） |
| 調査・重複確認・Issue案・Issue作成 | 既存のChat（`src/lib/chat/handlers.ts`）とIssue作成サービス |
| 現行のChatGPT側Webhook処理 | IssueDeckの外。**切替の前に止める**（下記） |

- 依頼単位は親投稿の`teamId + channelId + parentTs`（`SlackIntakeRequest`の一意制約）。処理済みのイベント・操作は`SlackProcessedEvent`で除外する。
- 返信は`postBotReply`だけが送り、**依頼者へのメンション（`<@USER_ID>`）が必ず付く**。Botトークンの名義で、`as_user`・`username`の上書きはしない。
- 対象リポジトリは「IssueDeckに接続済み**かつ**投稿者の`UserInstallation`に含まれる」ものから生成し、`SLACK_ALLOWED_REPO_OWNERS`で絞れる。本文に一意なアプリ名／リポジトリ名があれば事前選択するが、**確定した選択だけが正本**。
- 補足は本文を書き換えず**コメントで追記**する（コメントは消せるため。新しいIssueを増やさない側に倒す）。補足・質問・お礼の分類は`src/lib/slack/classify.ts`の決まった言い回しで、LLMには任せない。
- 失敗（Slack API・GitHub API・権限喪失・対象未選択）は、完了とせず⚠️と**段階・理由・未完了・再試行可否・再開方法**を同じスレッドへ返す。失敗した依頼は「再開」と返信すると同じ段階からやり直す。
- 添付ファイルは**名称だけを依頼に残し「内容は未取得・未確認」と明示する**（ファイル本文の取得は未実装）。

## 設定（サーバーの環境変数。値はリポジトリ・画面・ログへ出さない）

| 変数 | 内容 |
|---|---|
| `SLACK_SIGNING_SECRET` | Slack Appの Signing Secret（必須） |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token `xoxb-…`（必須） |
| `SLACK_USER_MAP` | `{"<SlackユーザーID>":"<IssueDeckのユーザーID>"}`。載っていないSlackユーザーは無視する |
| `SLACK_ALLOWED_TEAM_IDS` / `SLACK_ALLOWED_CHANNEL_IDS` | 既定は`T0C8GTB3CP6` / `C0C873R7JTV` |
| `SLACK_ALLOWED_REPO_OWNERS` | 候補にするOrganization／ユーザー。未設定なら制限しない |

必須の2つが無ければ連携は無効（受け口は503）。`.github/secrets-manifest.tsv`には**まだ足していない**（デプロイ値検査に未登録の行を持ち込まないため。サーバーの`.env`へ直接置く。移行は手作業Issueで追跡する）。

## Slack Appの設定（手作業）

1. https://api.slack.com/apps で新規App（名前: IssueDeck）を作成する
2. **OAuth & Permissions**のBot Token Scopesに`chat:write`・`reactions:write`・`channels:history`・`channels:read`（privateチャンネルなら`groups:history`・`groups:read`）を付けてWorkspaceへインストールする。スコープを変えたら**再インストール**が必要
3. **Event Subscriptions**: Request URLに`https://<IssueDeckのホスト>/api/slack/events`（`challenge`に応答して検証が通る）。Subscribe to bot eventsに`message.channels`（privateなら`message.groups`）を追加する
4. **Interactivity & Shortcuts**: Request URLに`/api/slack/interactions`、Select Menus の Options Load URLに`/api/slack/options`
5. Signing SecretとBot Tokenをサーバーの`.env`へ置き、アプリを再起動する。`SLACK_USER_MAP`に依頼者を登録する
6. `#アプリissue起案`で`/invite @IssueDeck`してBotをチャンネルへ参加させる

## 現行ChatGPT処理からの切替・ロールバック

**二重起案を避ける順序（必須）**: ①ChatGPT側のWebhook自動処理を**先に止める** → ②IssueDeck側の環境変数を有効化して再起動 → ③テスト投稿で動作確認。
併存期間の保険として、起案前に**元投稿のpermalinkを本文に持つ既存Issue**（open/closed）をDBから探し、あれば新規作成せず既存を返す。IssueDeckが作ったIssueは本文末尾に`<!-- slack-intake: team/channel/ts -->`とpermalinkを持つ。

- **既存スレッドの対応は失われない**: ChatGPT側が起案したIssueはpermalink検索で拾える。IssueDeck側の依頼は`SlackIntakeRequest`に残る。
- **ロールバック**: `SLACK_SIGNING_SECRET`を空にして再起動すれば受け口は503になり、IssueDeck側は何もしない（DBのデータは残る）。そのうえでChatGPT側を再開する。**両方を同時に動かさない**。

## 検証済みの範囲と、まだ検証していないこと

vitestで、不正署名・古いタイムスタンプ・対象外チャンネル／Workspace・未対応ユーザー・Bot投稿・リンク展開（編集イベント）の拒否／無視、再送・連打の二重処理防止、確定前にIssueを作らないこと、メンション付与、トークン非露出、補足・質問・お礼の分岐、失敗時の⚠️を確かめている。**実際のSlack Appとの疎通・ChatGPT処理との同時稼働テストはApp作成後の手作業**（手作業Issueで追跡）。
