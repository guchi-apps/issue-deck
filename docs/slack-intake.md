# Slackからのissue起案（#4454）

Slackの`#アプリissue起案`への投稿から、**AIが対象リポジトリを判別し、実装と関連Issue／PRを調べ、承認の操作なしで**Issueを起案し、結果をIssueDeckのbot名義・依頼者メンション付きで同じスレッドへ返す（#4527。#4454の「対象選択＋起案承認」の2段階確認は廃止した）。調査・重複確認・Issue案づくりは既存のIssueDeck Chat（[chat.md](chat.md)）を呼ぶだけで、判定は複製していない。

## 流れと責任境界

```text
投稿 → POST /api/slack/events（署名検証→受付〈DBへの保存のみ〉→即ack→非同期）
  └ 新規の親投稿: ack前にSlackIntakeRequest（received）を作成 → ack後に👀 → 対象の判別（src/lib/slack/target.ts）
       ├ 一意に決まる（owner/repo明示 → 名称の一意一致 → AIが許可候補から判別）: そのまま調査へ
       └ 決まらない／複数候補: 関連候補の選択メニュー＋名称検索メニューを同じスレッドへ出して聞く（awaiting_repo。#4565）
            └ 利用者が返信で答える → ack前にresumingへ → 判別し直して調査へ（再度の承認なし）
  └ 調査・重複確認（handleChatMessage）→ 調査が成立し、重複が無ければ承認なしで作成:
       confirming/queuedを保存 → 既存更新を照合・作成 → 結果とdoneを同時保存 → 「こういう内容で起案しました」＋Issueリンク
  └ スレッド返信（依頼者本人のみ）: お礼→何もしない／質問→同じスレッドで回答／補足→既存Issueへコメント追記／
       「別件」と明示→分割案（相互リンク）／Issue未作成の間の返信→材料に足して案を作り直す
```

## 自動起案の条件と、作らないとき

自動で作るのは、次がすべて揃ったときだけ。**揃わなければ作らず、理由と再開方法を同じスレッドへ返す**（未調査の定型案を作ることはない）。

| 状況 | 動き |
|---|---|
| 調査が成立（AI停止・調査の中断・定型フォールバック案・実装／Issueを読んだ根拠ゼロのどれでもない） | 承認なしで作成し、完了を返す |
| AI停止・調査が途中で止まった・根拠ゼロ・フォールバック案 | 作らない。「未調査の案は作成していません」と理由・「再開」の返信を返す（`failed`） |
| 案に似た既存の**open**Issueがある（`card.duplicates`。コード側の判定） | 作らず、リンクと状態を返す。先頭を追記先（`reused`）に残し、以後の補足はそこへコメントする。別の成果なら「別件」と返信 |
| 既に対応中・対応済み（closed Issue・PR・本番反映済み）で調査が案を返さなかった | 作らず、調査の説明（リンク・状態）を返す。**closed IssueとPRの重複は`findDuplicates`の対象外で、調査のsearch系ツールの結果をAIが読んで判断する**ため、ここはコードによる保証ではない |
| 対象が許可候補にない（権限外・未接続のowner/repoを明示） | 作らず、起案できない旨を返す |
| 作成直前の権限・対象整合性の再検証に失敗 | GitHubを更新しない |

- 判定根拠は`SlackIntakeRequest.targetBasis`と起動ログ（`[slack-intake] 対象判別`）に残す。対象が変わると会話（調査結果・案）を作り直す。
- AIの判別は候補（許可済み）にあるものしか採用しない。投稿者が権限を持つ接続済みリポジトリだけが候補で、各候補には最近のIssue題名を手がかりとして渡す。AIが使えないときは、AI抜きの確定（明示・名称一致・語の一致で強く一意）ができなければ**対象を聞く**（Issueは作らない）。聞くときは、依頼の語とリポジトリ名・最近のIssue題名の一致で絞った関連候補（最大5件）だけを選択メニューに出し、**無関係な先頭の候補は並べない**。候補外の許可済みリポジトリは名称検索のメニューから選べる。メニューは選ぶだけで確定し、連打・旧UIは`awaiting_repo`の取得で1回に絞る（#4565）。AI判別の失敗理由は返信に残す。

### AI実行先（#4565）

- **調査**は設定済みの実行先に従う。Claude設定は共通のAPI経路、Codex設定はChatと同じ`createCodexSession`（サブPCのログイン済みCodex CLI。`ChatRun`を作る）で動かし、OpenAI APIへは逃がさない。
- **対象判別**は常にClaude APIで、Codex設定のときはAPIを呼ばず語の一致だけで絞る。
- 調査の失敗は`describeUnavailable`の種別（認証・利用枠・実行ホスト・時間切れ・根拠不足）ごとに、理由と必要な操作を返す。設定を直さないと回復しない種別は「待っても直らない」と明記し、「再開」で依頼・選択済み対象を保ったまま続ける。
- 調査の指示（現状と要望の差・既存の対応の区別・タイトルの命名慣例）は、Slack専用の定型ではなく既存のChat調査へ渡す指示文（`SLACK_PROPOSAL_INSTRUCTION`）で与える。
- **旧フローの確認待ち（`awaiting_confirm`）の依頼は失わない。** 残っている「この案で起案する」「やめる」ボタンと、対象選択ボタン（`awaiting_repo`）は、押せば従来どおり動く（対象選択ボタンを押した後は新フローの承認なしの起案へ進む）。

| 担当 | 場所 |
|---|---|
| イベント受付・署名検証・許可判定・冪等性・Slack投稿 | IssueDeck（`src/lib/slack/`・`src/app/api/slack/`） |
| 調査・重複確認・Issue案・Issue作成 | 既存のChat（`src/lib/chat/handlers.ts`）とIssue作成サービス |
| 現行のChatGPT側Webhook処理 | IssueDeckの外。**切替の前に止める**（下記） |

- 依頼単位は親投稿の`teamId + channelId + parentTs`（`SlackIntakeRequest`の一意制約）。処理済みのイベント・操作は`SlackProcessedEvent`で除外する。
- 返信は`postBotReply`だけが送り、**依頼者へのメンション（`<@USER_ID>`）が必ず付く**。Botトークンの名義で、`as_user`・`username`の上書きはしない。
- 対象リポジトリは「IssueDeckに接続済み**かつ**投稿者の`UserInstallation`に含まれる」ものから生成し、`SLACK_ALLOWED_REPO_OWNERS`で絞れる。AIの判別も利用者の回答もこの候補の中だけで受け、**確定した`selectedRepo`が正本**。調査の前と作成の直前に、候補にあることと権限を再検証する。
- **対象確認の返信は補足として本文に足し、`resuming`にして判別し直す**。回答の名前・owner/repoが優先される（元の投稿に別のアプリ名があっても、利用者が答えた対象で確定する）。回答で決まらなければもう一度聞く。
- 補足は本文を書き換えず**コメントで追記**する（コメントは消せるため。新しいIssueを増やさない側に倒す）。補足・質問・お礼の分類は`src/lib/slack/classify.ts`の決まった言い回しで、LLMには任せない。
- 失敗（Slack API・GitHub API・権限喪失・対象未選択）は、完了とせず⚠️と**段階・理由・未完了・再試行可否・再開方法**を同じスレッドへ返す。失敗した依頼は「再開」と返信すると同じ段階からやり直す。
- **ack前に依頼をDBへ残す**（#4488）。親投稿は処理済み記録（`SlackProcessedEvent`）と同じトランザクションで`received`の`SlackIntakeRequest`にし、保存に失敗したら500を返してSlackに再送させる（処理済み記録も巻き戻る）。ack前はDBの読み書きだけで、Slack API・GitHub・AIはack後に呼ぶ（3秒制限）。「再開」の返信もack前に`resuming`へ書き、起案前の補足はack前に本文へ足して終える。
- ack後の処理がプロセスの停止などで止まった行（`received`は2分、`resuming`・`investigating`は30分`updatedAt`が動いていないもの）は、起動時と5分おきの巡回（`src/lib/slack/intake-resume.ts`）が拾い直す。読んだ時点の`updatedAt`を条件に更新して処理権を取るので、同じ行を2か所で同時に進めない。拾い直しで質問や調査が重ねて走ることはあるが、Issueの作成は`confirmState`の`queued`→`processing`の処理権と、案ごとの`confirmationId`をGitHub側のIssue本文と照合する識別子で守っているため、二重には作られない（自動起案でも変わらない）。
- **起案済みの依頼への返信（質問・補足のコメント追記・分割）は、返信本文をDBへ残さない。** ack後の失敗はスレッドへ⚠️で返すが、処理中にプロセスが止まるとその返信だけは拾い直せない（依頼とIssueは作成済みで失われない。もう一度返信すれば続く）。本文を残す列の追加はスキーマ変更になるため見送った。
- 添付ファイルは**名称だけを依頼に残し「内容は未取得・未確認」と明示する**（ファイル本文の取得は未実装）。

## 設定（サーバーの環境変数。値はリポジトリ・画面・ログへ出さない）

| 変数 | 内容 |
|---|---|
| `SLACK_SIGNING_SECRET` | Slack Appの Signing Secret（必須） |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token `xoxb-…`（必須） |
| `SLACK_USER_MAP` | `{"<SlackユーザーID>":"<IssueDeckのユーザーID>"}`。載っていないSlackユーザーは無視する |
| `SLACK_ALLOWED_TEAM_IDS` / `SLACK_ALLOWED_CHANNEL_IDS` | 既定は`T0C8GTB3CP6` / `C0C873R7JTV` |
| `SLACK_ALLOWED_REPO_OWNERS` | 候補にするOrganization／ユーザー。未設定なら制限しない |

必須の2つが無ければ連携は無効（受け口は503）。`.github/secrets-manifest.tsv`には**まだ足していない**（デプロイ値検査に未登録の行を持ち込まないため。サーバーの`.env`へ直接置く）。デプロイの`update_env`は自分が管理するキーだけを書き換えるので、直接置いた`SLACK_*`はデプロイで消えない。**このためリリースをデプロイしただけでは連携は無効のまま（503）で、ChatGPT側の処理がそのまま動き続ける。** 有効化（App作成→旧Webhook停止→`.env`設定・再起動→実投稿確認）は手作業Issue #4461で追跡する。

## Slack Appの設定（手作業）

リリースによる受け口の配布と、Slack連携の有効化は別の工程です。設定と旧Webhookからの切替は、本番反映後の手作業Issue #4461で行います。有効化前のリリース案内には「Slack連携はまだ有効になっていません」と明記します。

1. https://api.slack.com/apps で新規App（名前: IssueDeck）を作成する
2. **OAuth & Permissions**のBot Token Scopesに`chat:write`・`reactions:write`・`channels:history`・`channels:read`（privateチャンネルなら`groups:history`・`groups:read`）を付けてWorkspaceへインストールする。スコープを変えたら**再インストール**が必要
3. **Event Subscriptions**: Request URLに`https://<IssueDeckのホスト>/api/slack/events`（`challenge`に応答して検証が通る）。Subscribe to bot eventsに`message.channels`（privateなら`message.groups`）を追加する
4. **Interactivity & Shortcuts**: Request URLに`https://<IssueDeckのホスト>/api/slack/interactions`、Select Menus の Options Load URLに`https://<IssueDeckのホスト>/api/slack/options`（Slackの設定画面には完全なHTTPS URLを指定する）
5. Signing SecretとBot Tokenをサーバーの`.env`へ置き、アプリを再起動する。`SLACK_USER_MAP`に依頼者を登録する
6. `#アプリissue起案`で`/invite @IssueDeck`してBotをチャンネルへ参加させる

## 現行ChatGPT処理からの切替・ロールバック

**二重起案を避ける順序（必須）**: ①ChatGPT側のWebhook自動処理を**先に止める** → ②IssueDeck側の環境変数を有効化して再起動 → ③テスト投稿で動作確認。
併存期間の保険として、起案前に**元投稿のpermalinkを本文に持つ既存Issue**（open/closed）をDBから探し、あれば新規作成せず既存を返す。IssueDeckが作ったIssueは本文末尾に`<!-- slack-intake: team/channel/ts -->`とpermalinkを持つ。

- **既存スレッドの対応は失われない**: ChatGPT側が起案したIssueはpermalink検索で拾える。IssueDeck側の依頼は`SlackIntakeRequest`に残る。
- **ロールバック**: `SLACK_SIGNING_SECRET`を空にして再起動すれば受け口は503になり、IssueDeck側は何もしない（DBのデータは残る）。そのうえでChatGPT側を再開する。**両方を同時に動かさない**。

## 検証済みの範囲と、まだ検証していないこと

vitestで、新フロー（明示・名称一致・AI判別の自動起案、対象不明時の確認と回答後の続行、重複・AI停止・調査不成立での非作成、結果返信失敗からの再送、並行・再送で二重作成しないこと）に加えて、不正署名・古いタイムスタンプ・対象外チャンネル／Workspace・未対応ユーザー・Bot投稿・リンク展開（編集イベント）の拒否／無視、再送・連打の二重処理防止、確定前にIssueを作らないこと、メンション付与、トークン非露出、補足・質問・お礼の分岐、失敗時の⚠️を確かめている。**実際のSlack Appとの疎通・ChatGPT処理からの切替確認はApp作成後の手作業**（#4461で追跡）。

### 選択した起案先の保証

AIが返す `confirm_issue` の `repo` は選択済みの `selectedRepo` と一致する必要がある。案の保存前と確認ボタンによるGitHub更新前の両方で検証し、不一致ならGitHubを更新せず失敗状態と再開方法を返す。起案先だけを書き換えると、別リポジトリの調査内容や重複Issueを流用するため、案を再調査する。

### 起案確定の中断回復

自動起案は、調査・重複確認を通った案を `confirming/queued` と案ごとの `confirmationId` としてDBへ保存してから作成する（旧フローの確認ボタンは、押下をack前に同じ状態へ保存する）。保存失敗は503としSlackに再送させる。GitHub更新中は `processing` とし、30分停止した行を巡回が回収する。完了は結果のIssue番号と `done` を同じDB更新で保存する。

再開前には検索索引や同期DBでなく、closedも含むGitHub REST一覧・コメントから `slack-intake-confirm` 識別子を照合する。既存更新があれば結果だけを回復する。照合失敗・外部更新結果不明は未作成と解釈せず回収対象に残す。識別子はスレッド単位ではなく案単位とし、同じスレッドの別分割案を混同しない。

### 結果返信の失敗からの再開（#4527）

作成の結果（Issue番号・`status: done`）を保存した直後は `confirmState: reply_pending` とし、Slackへ「起案しました」を返せたら `done` にする。GitHubに作成した後でSlackへの返信だけが失敗した場合は `reply_pending` のまま残り、巡回（起動時と5分おき）が**返信だけを再送する**。Issueの作成・照合はもう行わないので二重作成にならない。返信本文は保存済みの案とIssue記録から組み立てるため、再送でも同じ内容になる。

### 既知の制限

- 調査・作成中（`investigating`・`confirming`）に来た補足は、依頼の本文へ足されるだけで、すでに始まった調査・作成には反映されない（作成後に返信し直すとIssueへコメントとして追記される）。
- 添付は名称だけを取得し、画像などの内容を読んだ根拠にはしない。

### 親子Issueの起案（#4537）

調査の結果、**独立して実装・検証できる単位が2件以上あり依存関係がある依頼**だけを、親Issue＋子Issue＋実行計画としてまとめて起案する（小さな依頼は従来どおり単一Issue）。Slack専用の処理は作らず、共通サービス（[epic-draft.md](epic-draft.md)）を呼ぶ。Slackは単一Issueと同じく**承認を挟まず**作り、bot名義で親子のリンク・実行順序（進む条件つき）を同じスレッドへ返す。**起案しても子は実装を開始しない。** 実行は親から開始する。

- 親は選択済みの`selectedRepo`、子は許可候補（接続済み・依頼者の権限内）のリポジトリだけ。権限内にない子があれば何も作らない。子は最大5件で、超えたら作らず絞り込みを依頼する
- `existing`でない子に似たopenなIssueがあれば、何も作らずリンクと状態を返す（重複作成しない）
- 保存形は`SlackIntakeRequest.proposal`の`{epic, requestKey}`（単一Issue案の`card`・`confirmationId`とは別経路。旧`awaiting_confirm`には触れない）。`issues`には親（`primary`）・新規の子（`child`）・再利用した既存（`reused`）を`key`つきで残す
- 途中で止まったら（照合失敗・親のみ・一部の子のみ・紐付け失敗・計画登録失敗）、完了とは言わず段階・作成済みの範囲・再開方法を返す。「再開」と返信すると**調査し直さず保存済みの案から**不足分だけ続ける。作成済みの範囲があるため、補足の返信は親Issueへのコメントになる
- 結果返信だけが失敗した場合は`reply_pending`に残り、巡回が返信だけを再送する（親子は作り直さない）
