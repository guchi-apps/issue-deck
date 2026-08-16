# 複数リポジトリに影響する変更の進め方

#1698 に対応する運用ドキュメント。「同じ直しを複数のリポジトリへ入れたい」と分かったときに、
**何が自動で配られ、何を人が配るのか**をまとめる。

- 導入済みリポジトリの一覧・配布状況の実測は [supported-repositories.md](supported-repositories.md)
- 未導入リポジトリへ運用一式を入れる手順は [cross-repo-setup-guide.md](cross-repo-setup-guide.md)
- 展開方式そのものの選択肢比較（調査）は [cross-repo-automation.md](cross-repo-automation.md)
- 本ドキュメントは、**既に導入済みのリポジトリ群へ変更を横展開するとき**の進め方に絞る

## 結論 — Issueを起点に他リポジトリへPRが自動作成されることはない

あるリポジトリでIssueを作っても、他のリポジトリにIssueもPRも作られない。**Issueを起点にした
横展開の自動化は存在しない。**

自動でPRが作られる経路は**共有ワークフローの参照タグ配布1つだけ**で、これはIssueではなく
issue-deckの画面のボタン（アプリ設定 → 共有ワークフローのバージョン）から`workflow_dispatch`で
起動する（[.github/workflows/propagate-workflow-tag.yml](../.github/workflows/propagate-workflow-tag.yml)・
[.github/scripts/propagate-workflow-tag.sh](../.github/scripts/propagate-workflow-tag.sh)）。
書き換えるのも`@workflows/vN`と`prompts-ref`の2つだけで、**内容の変更は一切運ばない**。

### なぜ自動化していないのか

思想として避けているのではなく、**実行体が1リポジトリしか見られない**という構造による。

- **無人実行（GitHub Actions）は1リポジトリしかcheckoutしない。** そのため構造的に横断できない
  （[multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md)「複数リポジトリ横断の質問セッション」）
- **ローカルの実装セッションはIssue 1件＝worktree 1つ**で、担当Issue以外の実装は
  [CLAUDE.md](../CLAUDE.md)「実装エージェントの禁止事項」で明示的に禁止している。進捗の遷移・
  closeがブランチ名`issue-<番号>`だけを見ているため、混ぜると起票側が`Ready`のまま取り残される
- **横断して読める実行体は横断質問セッションだけで、それは読み取り専用**である
  （`--disallowedTools "Edit,Write,NotebookEdit"`。[scripts/start-cross-repo-question.sh](../scripts/start-cross-repo-question.sh)）
- 画面のIssue作成も**単一リポジトリ固定**（`repositoryFullName`は1つだけ受け取る。
  [src/components/dashboard/create-issue-dialog.tsx](../src/components/dashboard/create-issue-dialog.tsx)・
  [src/app/api/issues/route.ts](../src/app/api/issues/route.ts)の`handlePOST`）

つまり**「1リポジトリ＝1実行体＝1Issue」が運用全体の前提**になっており、横展開はその外側で
人が並べる形になっている。

## 変更の種類ごとの配り方

横展開したい変更は次のどれかに当てはまる。**自動で配られるのは1行目だけ。**

| 変更の種類 | 配り方 | 自動化 | 参照 |
|---|---|---|---|
| 共有ワークフローの**中身**（`reusable-*.yml`） | issue-deckで直す → `workflows/vN`タグを切る → 画面から一括配布PR（既定で自動マージ） | **あり** | [cross-repo-setup-guide.md](cross-repo-setup-guide.md)「画面から一括でタグ更新PRを作る」 |
| callerの`on:`・`with:` | 手。**タグ配布は書き換えない**ため、issue-deck側でトリガーを変えたら全callerを横断確認する | なし | [supported-repositories.md](supported-repositories.md)「タグが記録しないもの」（#1366） |
| callerの新規追加（`release-develop-to-main.yml`等） | 手。配布は既存ファイルの置換だけで、callerの新規追加はしない | なし | [supported-repositories.md](supported-repositories.md)の各「配布状況」 |
| ラベル体系 | `guchi-apps/docs`の`label-sync/sync-labels.sh`をリポジトリごとに流す | なし | [cross-repo-setup-guide.md](cross-repo-setup-guide.md)「2. ラベル体系」 |
| Secrets・variables | リポジトリごと。共通値はorganizationへ寄せる | 一部 | [cross-repo-setup-guide.md](cross-repo-setup-guide.md)「4. Secrets」 |
| 全アプリ共通の知識（`CLAUDE.md`・運用ルール） | 提案コメント → 承認 → 共有知識リポジトリへのPR | 一部 | [shared-knowledge.md](shared-knowledge.md)「9. 共有知識更新フロー」 |
| **アプリのコードそのもの**（同じ不具合が各アプリにある等） | **リポジトリごとにIssueを立てて個別に実装する。これ以外の手段は無い** | なし | 下記の手順 |

## アプリのコードを横展開する手順

自動化が無いのはこの行だけで、実際に手間がかかるのもここ。次の順で進める。

### 1. 影響範囲を横断質問で出す

どのリポジトリが該当するかを先に確定させる。**推測で列挙しない。** issue-deckの画面の
「横断質問」（PCはヘッダー・スマホはIssue一覧の「？」）から聞くと、サブPCが全リポジトリの
チェックアウトを`--add-dir`で参照した読み取り専用セッションで答える。

質問例: 「`withUserGithubToken`と同じ形でトークンを復号している箇所が、issue-deck以外の
どのリポジトリのどのファイルにあるか」

**Actionsの「リポジトリに質問する」（`@claude 質問:`）ではできない。** そちらは1リポジトリしか
checkoutしないため、横断の問いには構造的に答えられない。

### 2. 親Issueを1つ立てる

横展開そのものを追跡する器を、**変更の発生元リポジトリ**（多くはissue-deck）に立てる。本文に
書くのは、何を配るのか・対象リポジトリの一覧・なぜ横展開が要るのか。ここでは実装しない。

### 3. リポジトリごとに子Issueを立て、サブIssueで紐付ける

対象リポジトリそれぞれに実装用のIssueを立て、GitHubネイティブのサブIssueとして親へ紐付ける。

```bash
gh issue create --repo guchi-apps/<repo> --title "..." --body "..."
CHILD_ID=$(gh api repos/guchi-apps/<repo>/issues/<番号> --jq .id)
gh api repos/guchi-apps/issue-deck/issues/<親番号>/sub_issues --method POST -F sub_issue_id="$CHILD_ID"
```

親のIssue詳細に「子Issue」セクションと進捗バー（`n / m 完了`）が出るため、**どこまで配ったかが
盤面に残る**。これが本文に手で書いた一覧との違いで、手書きの一覧は必ず実態とずれる
（[supported-repositories.md](supported-repositories.md)の配布状況の表がまさにその手書きにあたり、
「正はcallerファイル」と注記して維持している）。

別リポジトリの子には、行にリポジトリ名（`car-care`など）が付く。同じリポジトリの子には付かないので、
**どれが横展開先の子なのかが一覧で見分けられる**。進捗も子が置かれているリポジトリのキャッシュから
引くため、番号が一致する親リポジトリ側のIssueと取り違えることはない（#1722で修正。それ以前は
「進捗の表示だけは信用しない」という制約があった）。

### 4. リポジトリごとに実装する

子Issueをそれぞれ独立に実装する。導入済みリポジトリなら、issue-deckの画面から「実装を開始」
（無人実行）でも「ローカルで開始」でも起動できる。**1つのセッションで複数リポジトリを触らない。**

### 5. 見送るリポジトリは`90.Close: another`で閉じない

`90.Close: another`（他のリポジトリで対応したため、クローズ）は**同じ要件が別リポジトリで
片付いた**ときに使う。横展開で「このリポジトリには不要だった」と判断した場合は
`90.Close: wonfix`のほうが実態に合う。

## 一括起票機能は作らない（#1722）

上記手順の1〜3のうち、**3（リポジトリごとの起票と紐付け）だけが定型作業**で、対象が14リポジトリ
あると`gh issue create`と`sub_issues`の往復を14回繰り返すことになる。ここを画面のボタン1つにする
案を#1722で検討したが、**作らないと決めた**。

**親リポジトリのローカルセッションが、そのまま手順3を実行できる**ため。ローカルの`gh`はユーザー
本人のトークンで動くので、親Issueを担当するセッションに「対象リポジトリへ子Issueを立てて紐付けて
ほしい」と頼めば、上のコマンドをそのまま繰り返す。画面のボタンにして得られるのは往復の削減だけで、
代わりにラベルの揃い判定・二度押し防止・部分成功の表示を恒久的に抱えることになる。

**無人実行（GitHub Actions）では、UIの有無にかかわらず横展開の起票はできない。** Actionsの
`GITHUB_TOKEN`は自リポジトリしか触れず（[actions-token-model.md](actions-token-model.md)）、
一括起票UIを作ってもそこは変わらない。

以下は、当時まとめた設計案の記録。作るとなったら出発点になるが、**現時点で作る予定は無い**。

### やること

Issue作成ダイアログに「複数のリポジトリへ同じ内容で作る」モードを足す。

1. リポジトリを複数選択する（既定は`claude-issue-dispatch.yml`を持つ導入済みリポジトリ）
2. タイトル・本文・ラベルは1回だけ入力する
3. 起票元のリポジトリに**親Issue**を1件、選択した各リポジトリに**子Issue**を1件ずつ作る
4. 子を親へサブIssueとして紐付ける
5. 結果（成功したリポジトリ・失敗したリポジトリ）を画面に返す

### 既にある部品

| 必要なもの | 既存 | 不足 |
|---|---|---|
| Issue作成 | `createIssue`（[src/lib/github/issues-api.ts](../src/lib/github/issues-api.ts)）・`POST /api/issues` | 単一リポジトリ前提。ループさせる層が無い |
| 対象リポジトリの一覧 | `Repository.hasClaudeWorkflow`（[prisma/schema.prisma](../prisma/schema.prisma)。`claude-issue-dispatch.yml`の有無で[src/lib/github/repository-sync.ts](../src/lib/github/repository-sync.ts)が立てる） | なし |
| ラベル一覧 | GitHub APIから直接引く（[src/lib/github/issues-api.ts](../src/lib/github/issues-api.ts)の`/labels`） | リポジトリごとに引き直す必要がある |
| サブIssueの**読み取り** | `GET /api/issues/sub-issues`・`fetchSubIssueRelations`（別リポジトリの子にも対応済み・#1722） | — |
| サブIssueの**書き込み** | **無い**（GETのみ）。画面から呼ぶ相手がいないため新設していない | `POST /repos/{owner}/{repo}/issues/{n}/sub_issues`を叩く経路の新設 |

### 懸念点

1. **ラベルはリポジトリごとに揃っていない。** `25.artifact-required`はローカルセッション専用の
   ため他リポジトリへ配っていない（#1473）など、実際に差がある。存在しないラベルを指定すると
   起票そのものが失敗するため、**選択したリポジトリすべてに存在するラベルだけを選ばせる**か、
   **無いリポジトリでは黙って落とす**かを決める必要がある。前者のほうが事故が少ない
2. ~~**サブIssueは別リポジトリの子の進捗を正しく出せない。**~~ **解消済み**（#1722）。
   `GithubSubIssueRef`・`SubIssue`が`repositoryFullName`を持ち、`attachProjectStatus`は
   リポジトリごとに引くようになった。一括起票を作るかどうかとは独立に、手作業で立てた
   別リポジトリの子でも進捗が正しく出る
3. **部分成功をどう見せるか。** 14リポジトリのうち3件で失敗したときに、成功した11件を巻き戻す
   のは現実的でない。配布PRと同じく「**1件の失敗で残りを止めない**」を採り、失敗した
   リポジトリ名を画面に残して人が再実行する形が既存の流儀に合う
   （[.github/scripts/propagate-workflow-tag.sh](../.github/scripts/propagate-workflow-tag.sh)の冒頭コメント）
4. **連続実行を止める必要がある。** 一括タグ配布で実際に起きた問題と同じで、起票は数秒で返るが
   画面が更新されるまでに二度押しすると**同じ内容のIssueが2セット作られる**
   （[cross-repo-setup-guide.md](cross-repo-setup-guide.md)「連続して押せないようにしてある」）
5. **無人実行を自動で起こさない。** 起票と同時に全リポジトリで実装が走ると、承認前に14本のPRが
   開く。子Issueは`Ready`のまま作り、着手は既存の「実装を開始」から1件ずつ行う

### 採らなかった案

- **1つのIssueから複数リポジトリへPRを直接作る。** 実行体が1リポジトリしか見られないという
  前提を崩すことになり、進捗の遷移・`11.local`による二重起動の抑止・セッション表示が
  すべて「ブランチ名`issue-<番号>`」と「起動時のIssue番号1つ」に依存しているため、
  そこを含めた作り直しになる。得られるのは定型作業の削減だけで、割に合わない
- **共有ワークフローのタグ配布に相乗りする。** あの経路が自動マージまで許されているのは、
  差分が`@workflows/vN`の機械的な置換に限られ、**配布先で見ても判断材料が増えない**ため
  （[CLAUDE.md](../CLAUDE.md)「自動マージ不可カテゴリ」の唯一の例外）。アプリのコード変更を
  同じ経路へ載せると、この例外の根拠がそのまま崩れる

## 未確定・要判断

- 親Issueをどのリポジトリに置くか。変更の発生元に置く運用にしているが、**アプリを持たない
  `guchi-apps/question`**（横断質問の置き場）へ寄せる案もある。ただしあちらは盤面に載らず
  実装フローの導線も持たないため、追跡の器としては弱い
  （[supported-repositories.md](supported-repositories.md)「`guchi-apps/question`（質問専用・盤面外）」）
