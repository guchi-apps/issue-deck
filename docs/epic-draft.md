# 親子Issue・実行計画の共通起案（Slack・Chat）

**いつ読むか**: Slackまたは共通Chat/エージェント入口が、依頼を親子Issueと実行計画へ分けて起案する処理（`src/lib/epic-draft/`）を触るとき、または外部エージェントから同じ起案を使うとき（#4537）。

## 何をするか

調査後に「独立した実装・検証単位が複数あり、依存関係がある」と判断した依頼だけを、親Issue＋子Issue＋GitHubの親子関係＋構造化計画（[execution-plan.md](execution-plan.md)、#4535）としてまとめて作る。小さな依頼・単一の成果は通常のIssue（従来の`confirm_issue`）のままで、必ずEpic化はしない。**作成と実装開始は分ける。** 起案だけで子を起動せず、実行は親から開始する。

## 流れ

```text
調査（Chat） → proposal_kind=epic（親＋子案のJSON） → parseEpicDraft / validateEpicDraft
  → Slack: 承認なしで作成 → 報告 ／ Chat: confirm_epic カード → 「親子Issueを作成」→ 作成 → 結果カード
作成（createEpic）: 照合 → 親 → 子 → サブIssue紐付け → 計画登録 → 親本文の最終化
```

- 親: 目的・範囲・全体完了条件。子: 独立した要件と観測可能な完了条件（`body`）。子の依存は`dependsOn: [{key, conditions}]`で、条件は#4321/#4535の`closed/merged/released/verified`をそのまま使う
- 並行可能な範囲は依存から導いた段（`computeEpicStages`）。Slack報告・Chatカード・親本文に同じ順序が出る
- 同じ成果の既存Issueは子の`existing`に番号を入れて再利用する（本文は書き換えず、担当範囲を広げない。差分は新規の子にする）。`existing`でない子に似たopenなIssueがあれば、Slackは作らずリンクを返し、Chatはカードに警告を出す
- 検証（`validateEpicDraft`）: 子が2件未満・5件超、キー重複、存在しない依存先・自己依存・循環、条件の欠落、権限内にないリポジトリは作らない。理由を返す（定型のEpicは作らない）

## 再開可能な作成（新テーブルなし）

各作成単位（親は`parent`、子は`c1`…）の本文末尾に`<!-- epic-unit: <requestKey>/<単位キー> -->`を残し、再実行のたびに**親・子のrepoごとにopen/closedの両方をREST一覧で引いて照合**して、無いものだけ作る。

- 照合に失敗したrepoがあれば、未作成と解釈せず`reconcile`段階で止める（再作成しない）。同じ識別子が複数あればエラー
- `requestKey`: Slackは`<依頼ID>.<案ごとのUUID>`（保存済みの案とともに保存）、Chatは`chat-<メッセージID>`。同じ依頼の再送・押し直しで同じ値になり、親子は増えない
- 失敗段階は`reconcile`・`parent`・`children`・`link`・`plan`・`body`。どの段階で止まっても完了とは報告せず、作成済みの範囲と再開方法を返す。GitHubの紐付けは既存の親子関係を読んで足りない分だけ追加する。計画登録は同じ親への同じ内容の再登録を成功として扱うこと（冪等）
- 計画の登録が未接続・失敗のときは親子を作っても「完了」にならない

## 外部連携の呼び出し方

- **ChatGPT等の外部サービスに、このAPIや起案サービスが接続されているとは前提にしない。** 使える経路は次のとおり
  - IssueDeck Chat（画面）: 「Issueにして」「親子Issueとして起案して」と依頼すると`confirm_epic`カードが出る。承認方針は従来どおり（実行前に人が確認する）
  - Slack: `#アプリissue起案`の投稿（[slack-intake.md](slack-intake.md)）。承認なしで作成する
  - サブPCのセッション・無人実行: 構造化計画の登録・取得は[execution-plan.md](execution-plan.md)の`/api/execution-plans`（Bearer）。Issueの作成・紐付けは`gh`で行い、計画を登録する
- Slack以外の既存の承認方針（Chatの確認カード）は変更していない

## 補足・変更

- Slackで同じスレッドへ返信した補足は、親Issueへのコメントとして追記する（**補足だけで実行対象の子を黙って増やさない**）。起動済みの計画（`boundVersion`あり）への変更は、新しい版として提案する版管理のルール（execution-plan.md）に従う
- 起案時のAI停止・必須調査の失敗・権限不足では親子を作らず、段階と再開方法を返す

## 検証

`src/lib/epic-draft/epic-draft.test.ts`（検証・親のみ/一部子のみ/紐付け/計画登録失敗からの再開・照合失敗・既存再利用）、`src/lib/slack/intake.test.ts`「親子Issueの起案」（Slackの正常系・重複・権限外・再開・返信失敗）、`src/lib/chat/epic-confirm.test.ts`（Chatのカード実行・押し直し）。
