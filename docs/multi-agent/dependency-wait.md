# 実装セッションの依存待ち

**いつ読むか**: 実装セッションが他のIssue・PRの完了を待って保留する仕組み、またはその表示・自動再開を触るとき（#4321）。

## 何を解決するか

`11.local`は「ローカルで対応中（Actionsを起動しない）」の抑止フラグで、何を待っているのかは表せない。
保留コメントと`11.local`だけが残ると、依存先が完了しても誰も気付かず、会話を開いて手で再開するしかなかった。

## 構成

| 役割 | 場所 |
| --- | --- |
| 待ちの記録（依存先・条件・理由・追跡） | `SessionDependencyWait`（`prisma/schema.prisma`）。`DispatchSession`とは別にして、セッションが消えても残す |
| 条件の判断・文言（純関数） | `src/lib/dispatch/dependency-wait.ts` |
| 観測・登録・再開・巡回（IO） | `src/lib/dispatch/dependency-wait-run.ts` |
| セッションからの報告 | `scripts/report-dependency-wait.sh` → `POST /api/dispatch/sessions/dependency-wait`（`DISPATCH_SECRET`） |
| 定期照合 | pollerの`sweep_dependency_waits` → `POST /api/dispatch/dependency-wait/sweep` |
| 画面の操作（再確認・再開・解除・既存保留の登録） | `POST /api/dispatch/dependency-wait`（ログイン認証）。一覧・詳細・スマホは`GET /api/dispatch`の`dependencyWaits`を読む |

## 条件は区別する

`closed`（クローズ）・`merged`（PRのマージ）・`released`（マージ済みPRのマージコミットがmainの祖先）・
`verified`（実環境の検証。**機械では成立させない**）。クローズやdevelopへのマージだけで本番反映・検証済みとはみなさない。
未成立が残れば待機を維持し、判断不能な条件だけが残れば`NEEDS_CONFIRM`（人の確認）へ回す。

## 状態

`WAITING` → `RESUME_REQUESTED`（指示を積んだ）→ `RESUME_SENT`（ジョブ成功）→ `RESUMED`（送信後にセッションが
`WORKING`へ動いたのを確認）。送信しただけでは実行中にしない。失敗は`RESUME_FAILED`（理由付き・自動では蒸し返さず、
画面の「作業を再開」で再試行）。

## 二重起動の防止

- 同じIssueの待ちは`activeKey`（`repo#issue`）で1行
- `WAITING`系→`RESUME_REQUESTED`は`updateMany`の条件付き更新で1本だけが取る
- 巡回は行ごとに`lastSweepAt`で実行権を取り、60秒に1回へ抑える
- 通知（Issueコメント・`00.check-user`）は`notifiedKey`で状態の変わり目ごとに1回

## 既存の保留（#687相当）

待機の登録が無い`11.local`のIssueでは、コメントの保留表現と`owner/repo#番号`から**依存先の候補**を画面に出す。
自動では登録・再開せず、人が条件を選んで確定する（`gates.md`の「実行体が判断して送らない」と同じ線）。

## 再開の文面

固定の1行（`buildDependencyResumeInstruction`）で、依存先の参照だけが入る。既存の`INSTRUCTION`ジョブ
（3段階プロトコル・承認プロンプト中は送らない）で送る。**セッションが終了していれば、待ちの記録を残したまま
`RESUME_FAILED`で「セッションを復旧」へ案内する**（既存の復旧経路は履歴を引き継いで呼び戻す）。

## 未送信入力の退避（#4383）

入力欄に未送信の文字が残っていると、再開の指示（と通常の追加指示）はpollerの`instruction_ready`が見送る。
見送り理由は`DispatchJob.message`をそのまま失敗理由（`failureReason`）へ載せ、`SKIPPED`だけで終えない
（`src/lib/dispatch/input-stash.ts`が未送信入力・作業中・承認待ち・状態不明・退避失敗を分類する）。

**未送信入力が理由のときだけ**、画面に「未送信の入力を退避して、再開指示を送信」が出る（依存待ちパネルと
セッション詳細の追加指示）。確認ダイアログで対象・ホスト・セッション・今回の指示を見せ、押すと
`stashInput`を立てたジョブが積まれる。キャンセルでは何も変更しない。

- 前提は`instruction_ready`が返り値`3`（作業中・承認待ち・状態不明の確認は通り、入力欄だけが理由）のとき。
  それ以外は入力欄へ1キーも送らない（承認プロンプトの保護を迂回しない）
- 取得（`instruction_capture_input`）は、入力が1行で直下が枠線、かつ**カーソル位置が読み取った文字列の表示幅と
  一致する**ときだけ「完全」とみなす。複数行・折り返し・末尾の空白・読み取れない文字は、改行と折り返しを
  見分けられないため**消さずに止める**（理由付きで見送り）
- 2回取得して内容が一致し、状態も変わっていないことを確かめてから`POST /api/dispatch/input-stash`で保存する。
  **保存の応答を確認するまで消去しない**。消去は`C-e`→`C-u`の固定キーで、空になったことを確認してから
  今回の指示だけを3段階プロトコルで送る（元の入力は再送せず、連結もしない）
- 退避は`SessionInputStash`（`jobId`のunique＝二重退避しない）。本文はログイン必須の画面にだけ出し、GitHub・
  通常ログ・通知・ジョブの`message`へは出さない。保持7日（参照のたびに期限切れを削除）、画面から削除できる
- 送信待ちのジョブが`DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS`（10分）を過ぎても未処理なら理由付きで`RESUME_FAILED`
- Codexは`codex queue`の既存経路のままで、TUI操作（退避・消去）は行わない
