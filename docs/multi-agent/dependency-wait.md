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
