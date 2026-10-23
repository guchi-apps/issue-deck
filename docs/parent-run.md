# 親Issueの自動実行

**いつ読むか**: 親Issueの「計画内の子を実行開始」・子の自動起動・一時停止／再開・全体の完了判定を触るとき（#4536）。

## 何を解決するか

#4535の実行計画（`ExecutionPlan`）を持つ親から、未着手の子を**依存順に**既存のDispatch経路（`enqueueDispatchJob`）で起動し、
親で全体の進捗・止まっている理由・再開を管理する。**親は管理役で、自分では実装セッションを起こさない**。
計画を持たない本文のみのEpicは対象外（パネルも出ない）。

## 開始は「計画内の子の実装実行」だけを許可する

開始確認ダイアログが、対象の子・順序（段）・並行範囲・到達点・実行先（ホスト／agent／同時起動数）を示す。
**本番リリースや既存の必須承認（`22.merge-confirm-required`・自動マージ不可カテゴリ）は自動で許可しない**。
実行は開始時の計画版へ結びつき（`ParentRun.planVersion`・`ExecutionPlan.boundVersion`）、対象の子はその版から
`ParentRunChild`として固定する。後から計画・サブIssueが変わっても対象は増減せず、新しい版があることだけを親に出す。

## 状態と判定

判定は純関数`src/lib/parent-run/decide.ts`の`evaluateRun`が1か所で持つ。条件の語彙は#4321の`closed/merged/released/verified`で、
**Issueのクローズ・PR作成だけでは次へ進めない**。

| 条件 | 成立の証拠 |
| --- | --- |
| `closed` | 依存先Issueがクローズ |
| `merged`／`released` | `issue-<番号>`ブランチのPR（`branchPrs`）を解決し、`observeDependency`でマージ／main反映を確認。PRなし＝未着手、複数・取得失敗は成立とせず待機理由に残す。`merged`は**PRのbaseが統合ブランチ（develop）のときだけ**成立し、mainなど別ブランチへのマージは成立としない（#4570） |
| `verified` | 子ごとの本番確認の記録（`ParentRunChild.verifiedAt`。画面の「本番確認を記録」）。自動では成立しない |

- 子の状態: 完了／実行中（起動の受付中・起動待ち・実行中・マージ待ち）／待機（前提・実行先）／停止（前提の問題）／要対応（起動失敗・本人操作待ち・人の確認待ち・取得失敗・Issueが見つからない）
- **失敗・本人操作待ちの子に依存する後続は`blocked`で止め**、独立した子は継続する。対象Issueと必要な操作は親の帯と行に出る
- 待機を一律に`00.check-user`へ送らない。人の確認が要るのは`verified`・複数PR・取得失敗などに限る
- **親全体の完了**は、全子のdevelopマージ・本番（main）への反映・親全体の本番確認が揃ったとき（#4523/#4524の「本番確認が残れば未完了」と同じ定義）

## 二重起動しない仕組み

- 稼働中の実行は親ごとに1件（`ParentRun.activeKey @unique`）。連打・複数タブは409
- 子の起動は`launchState`の条件付き更新（`PENDING→LAUNCHING`）で1つの巡回・操作だけが取る。再試行は`attempt`を進めて取り直す
- 起動の受付中のまま止まった行（プロセス再起動）は2分で未起動へ戻す。ジョブが既にあれば`enqueueDispatchJob`が`already_queued`／`session_alive`を返し、
  **既存の実行を再利用**する（共有子・複数親でも同じ）
- 巡回は実行ごとの`lastSweepAt`の条件付き更新（30秒）で重なりを弾く。判定はDBとGitHubの現状から毎回やり直す
- ジョブ受付（`LAUNCHING`）・起動成功（`LAUNCHED`＋ジョブ）・実行中（セッションALIVE／PR）は別に扱う
- 実行先の問題（`host_offline`・`agent_not_capable`・`agent_paused`）は起動失敗にせず待機理由にして自動で再試行。`repository_not_runnable`などは起動失敗（再試行ボタン）

## 操作

| 操作 | 効果 |
| --- | --- |
| 新規起動を一時停止／再開 | 未起動の子の起動だけを止める。起動済みの子は止めない |
| 未起動の子を停止 | 未起動の子を`SKIPPED`にして実行を閉じる。**起動済みの子の中止は子ごとの既存の中止経路**（一括停止・`cancelDispatchJob`）を使う |
| 失敗した子の再試行 | 同じ計画・成果（PR・セッション）を引き継いで取り直す。開始時の対象外は再試行できない |
| 本番確認を記録 | 子（`verified`条件の証拠）・親全体（完了条件）。人が行う |

## 入口

- 子Issueの印（#4953）: 稼働中の親の実行の子に、一覧の行とIssue詳細の状態欄へ「親 #N の自動実行中」（phaseが`running`／`launching`。Statusが`Ready`のままでも一覧の「実行中」へ振り分ける）か「親 #N の順番待ち」（未起動の`ready`／`waiting`。「未着手」に残す）を出す。`attention`・`blocked`・`done`・`skipped`は印なし。判定は`src/lib/parent-run/child-state.ts`、引く処理は`child-state-query.ts`（`run.ts`はGitHub App認証を引きずるため分けてある）。Statusは書き換えない
- 画面: Issue詳細（PC・スマホ）の「自動実行」セクション（`components/dashboard/parent-run-section.tsx`）、一覧の親の行の印
- API: `GET/POST /api/parent-runs`（ログイン中の本人。`start`／`pause`／`resume`／`stop`／`retry`／`verify`）
- 巡回: `POST /api/dispatch/parent-run/sweep`（`DISPATCH_SECRET`）を`scripts/subpc-dispatch-poller.sh`の`sweep_parent_runs`が呼ぶ
- 実行の本体: `src/lib/parent-run/run.ts`

## 他との接続

- #4321（既存セッションの再開）: 子セッションが依存待ちで止まるのは従来どおり。親の自動実行は未起動の子の着手条件だけを見る
- #4523（リリース依存）: `released`の定義は同じ。リリース復旧系列自体は変えない。PRを持たない`timing`付きの作業（環境設定・本番確認）は、クローズ＋検証結果の記録（「本番確認を記録」）で`released`/`verified`が成立し、完了条件に「リリース前後の作業の検証」が加わる。区分とゲートは[execution-plan.md](execution-plan.md)
