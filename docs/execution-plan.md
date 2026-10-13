# 親子Issueの実行計画

**いつ読むか**: 親Issueと子Issueの実行順序・依存条件を構造化して登録・取得・更新するとき、またはそれを使う実行制御・起案（#4536・#4537）を触るとき（#4535）。

## 何を解決するか

親子関係と「次へ進める条件」を本文の自由文から読むと、編集で壊れ、別リポジトリの同番号を取り違える。
**構造化計画（DBの`ExecutionPlan`）を正とし、Issue本文は人向けの写し**にする。Slack・Chat・実行制御は同じ計画を使う。
**計画を持たない本文のみのEpicは従来どおり**で、親子関係があるだけで自動実行へ移行しない（計画の登録が自動実行の前提）。
このIssueでは登録・検証・取得・更新までで、子の自動起動は#4536。

## 完了の語彙（二重定義しない）

条件は#4321の`closed` / `merged` / `released` / `verified`（[dependency-wait.md](multi-agent/dependency-wait.md)）をそのまま使う。
**通常の実装依存の既定は`merged`（依存先の実装PRが統合ブランチ`develop`へマージ済み）。** Issueのクローズ（本番反映まで待つ運用）を暗黙の条件にしない。`released`・`verified`は本番機能・実環境確認が要る依存だけ明示し、省略は従来どおり拒否する（#4570）。
Issueのクローズ・PR作成・developへのマージ・本番反映・検証成功は別の条件で、前者が成立しても後者は満たさない。
**子Issueは`merged`/`released`を直接判定できない**ため、実行側は`issue-<番号>`ブランチをheadとするPRへ解決してから評価する
（`src/lib/execution-plan/register.ts`の`defaultVerifyDeps.branchPrs`）。PRが0件（着手前）は成立とせず、複数は登録時に拒否、
取得失敗は成立と解釈しない。

## 計画の形式

```json
{
  "repository": "guchi-apps/issue-deck", "issue": 100,
  "changeNote": "初回登録",
  "plan": {
    "objective": "親の目的",
    "completionCriteria": ["親全体の完了条件（子のクローズ・PR作成では満たされない）"],
    "children": [
      { "repository": "guchi-apps/issue-deck", "number": 1, "dependsOn": [] },
      { "repository": "guchi-apps/issue-deck", "number": 2, "dependsOn": [{ "repository": "guchi-apps/issue-deck", "number": 1, "conditions": ["merged"] }] },
      { "repository": "guchi-apps/vps", "number": 3, "dependsOn": [{ "repository": "guchi-apps/issue-deck", "number": 1, "conditions": ["merged"] }] },
      { "repository": "guchi-apps/issue-deck", "number": 4, "dependsOn": [
        { "repository": "guchi-apps/issue-deck", "number": 2, "conditions": ["verified"] },
        { "repository": "guchi-apps/vps", "number": 3, "conditions": ["verified"] } ] }
    ]
  }
}
```

- 参照は**常に`owner/repo`と番号**。番号だけの参照は拒否する
- 上の例は「1がdevelopへマージされたら2・3が並行可能、2・3の検証後に4」。並行可能な範囲は子の間の依存から導かれる**段**（`stages`）で返る
- 既存Issue・別リポジトリの子も同じ形で指定できる

## 入口（API）

`/api/execution-plans`。認証はログイン中の本人か`Authorization: Bearer $DISPATCH_SECRET`
（未設定は503、不一致は401）。**ChatGPT等の外部サービスにこのAPIが接続されているとは前提にしない**。
使える経路は、サブPCのセッション・無人実行からの`curl`（Bearer）と、issue-deckの画面・Chatからのサーバー内呼び出し。

| メソッド | 用途 |
| --- | --- |
| `GET ?repository=&issue=[&version=][&checkBody=1]` | 計画・段・版履歴の取得。`checkBody=1`で本文との不一致も返す。計画が無ければ404（**「依存なし」ではない**） |
| `POST` | 初回登録（上の形式）。`201` |
| `PATCH` | 新しい版として更新。**`expectedVersion`（直前に読んだ版）が必須**で、食い違えば409。`confirmRemove`に外す子を明示 |

登録時に次を検証し、**1つでも問題があれば何も保存せず、全ての問題を`errors[{path,message}]`で返す**（400=形式、422=GitHubとの照合、409=版の競合）。

- 形式: 自己依存・循環（経路を表示）・重複・不正な条件・条件の省略・親を子にする
- 照合: 存在しないIssue・IssueDeck未接続／権限外のリポジトリ・取得失敗（**存在しない／完了のどちらとも解釈しない**）・実装PRが複数
- GitHubのサブIssueとの対応は警告（`warnings`）。計画に入れたのにサブIssue未登録、計画に無いサブIssueがあるときに出る

## 版と実行

- 各版は不変のスナップショット（`ExecutionPlanVersion`）で、変更理由・作成者・日時が履歴になる
- **実行は開始時の版に結びつく**（`boundVersion`。`bindPlanVersion`）。計画を更新しても結びついた版は変わらず、稼働中の対象が黙って増減しない
- 再計画（PATCH）は`diff`（追加・削除・変更・維持）を返す。**完了（クローズ）済みの子は外せず**、未完了の子を外すには`confirmRemove`が要る。追加された子は`diff.added`で実行範囲に入れるかを明示して決める

## 本文との対応

`renderPlanBody`が親本文へ入れる節（`<!-- issue-deck:execution-plan:start vN -->`〜`end`）を作る。
`detectBodyMismatch`は節の有無・版・子一覧の食い違いを検出する。本文を手で直しても実行は変わらない。

## 今後（このIssueの範囲外）

子の自動起動と全体進捗は#4536（[parent-run.md](parent-run.md)）、Slack・共通起案での作成は#4537。#4520系列で作業の種別が増えたら条件の列挙を拡張する。
