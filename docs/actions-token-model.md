# GitHub Actions のトークンモデルと自己ループ防止機構

`.github/workflows/`配下のワークフロー群が使う2種類のトークン（既定の`GITHUB_TOKEN`と
`secrets.WORKFLOW_PAT`）の使い分け、その使い分けが支えている自己ループ防止機構、および
「他リポジトリを読めるようにする」際の選択肢を整理する。

発端は issue #357（他リポジトリでの実現可能性調査）で、GitHub Actions 上の実装エージェントが
`m-guchi/shopping-list`を読み取れず調査を完遂できなかったこと。その原因分析から、
「計画ステップの`GH_TOKEN`を`github.token`から`secrets.WORKFLOW_PAT`へ差し替えれば他リポジトリを
読めるのではないか」という案が出たため、そのメリット・デメリットを検証した。**結論としては
単純な差し替えは推奨しない。** 理由は本ドキュメントの「3. 差し替えのデメリット」を参照。

なお、この問題に対する現時点の方針は**案C（issue #360「Claudeアプリの画面が開くボタンを追加」）**
であり、実装が予定されている。本ドキュメントは、その方針を採らなかった場合・および案C では
カバーできない範囲が残った場合に備えた判断材料として残す。

## 1. 現状のトークン使い分け

### 2種類のトークン

| | `GITHUB_TOKEN`（`github.token`） | `secrets.WORKFLOW_PAT` |
|---|---|---|
| 種別 | GitHub がワークフロー実行ごとに自動発行 | ユーザーが発行した Fine-grained PAT |
| 有効期限 | ジョブ終了時に自動失効（使い捨て） | 最長366日。手動ローテーションが必要 |
| スコープ | **実行中のリポジトリ1つのみ**（GitHub 側で強制） | PAT 設定画面で選択したリポジトリのリスト |
| 権限の絞り込み | ジョブの`permissions:`ブロックで宣言的に絞れる | **`permissions:`は効かない**。PAT に付与した権限がそのまま通る |
| 操作の帰属 | `github-actions[bot]`（Bot） | PAT 所有者（`m-guchi`。User） |
| イベント発火 | **この操作は新しいワークフロー実行を生成しない** | 通常のユーザー操作と同様に発火する |
| レート制限 | 1,000 req/時・**リポジトリごと** | 5,000 req/時・**ユーザーごと（全用途で共有）** |

`WORKFLOW_PAT`は「workflow スコープ / Repository permissions > Workflows: Read and write」を持つ
Fine-grained PAT（`claude-issue-dispatch.yml`冒頭のコメント参照）。

### なぜ2種類あるのか

既定の`GITHUB_TOKEN`は`.github/workflows/`配下への push 権限を GitHub の仕様上**原理的に持てない**
（リポジトリの Workflow permissions 設定を Read and write にしても解除されない）。ワークフロー
ファイル自体を変更する Issue をエージェントが扱えるようにするため、PAT が必須になった（issue #106）。

副次的に、「`GITHUB_TOKEN`の操作はワークフローを発火させないが PAT の操作は発火させる」という
性質も利用している。develop 向け PR のマージ後に後続ジョブが発火しない問題（issue #112）は、
該当箇所を PAT に切り替えることで対処した。

### 使用箇所の棚卸し

| ワークフロー | `WORKFLOW_PAT`を使う箇所 | 目的 |
|---|---|---|
| `claude-issue-dispatch.yml` | `actions/checkout`の`token`、実装ステップの`GH_TOKEN`と`github_token`、`mode=additional`時の checkout、計画/実装フォールバック検証ステップの自動リトライで`gh workflow run`を呼ぶ際の`GH_TOKEN`（#497） | ワークフローファイルへの push、push/PR 作成による`issue-labels.yml`の発火、`workflow_dispatch`による自己再起動（`GITHUB_TOKEN`では発火しないため） |
| `claude-conflict-resolve.yml` | checkout の`token`（L89）、コンフリクト解消ステップの`GH_TOKEN`・`github_token`（L177・L189）、L130 | 同上 |
| `claude-review-develop.yml` | ラベル付け替えステップの`GH_TOKEN`（L245） | 後続ジョブを発火させるため（issue #112） |
| `release-develop-to-main.yml` | checkout の`token`（L68）、および各ステップの`GH_TOKEN`（L80・L122・L211・L279）、`github_token`（L151） | バージョン bump コミットの push と、それによる自身の再起動 |
| `issue-labels.yml` | **使わない**（全ステップ`secrets.GITHUB_TOKEN`） | ラベル操作のみで push を伴わないため |

上記以外の40箇所以上は`github.token`。**「PAT が構造的に必要な箇所だけに限定する」という
least privilege の方針が既に実践されている**。計画ステップ（`mode=plan`）の
`GH_TOKEN: ${{ github.token }}`もこの方針に沿った意図的な選択であり、うっかり漏れたものではない。

## 2. 自己ループ防止機構（3層構造）

エージェントが GitHub 上で行った操作が、自分自身のワークフローを再起動してしまうことを、
以下の3層で防いでいる。**このうち第1層・第2層はトークンの種別に依存している。**

なお、各操作が実際に GitHub 上で誰の名義として記録されるか（Bot か人間か）の経路ごとの
整理は[docs/attribution.md](attribution.md)を参照。第2層の Bot 判定は、その整理で扱っている
「アプリ経由のラベル操作・投稿者マーカーの仕組み」に依存している。

### 第1層: GitHub の仕様（トークン依存）

`GITHUB_TOKEN`を使って行った操作は、`workflow_dispatch`・`repository_dispatch`を除き、
**イベント自体が生成されない**。エージェントがコメントを投稿してもラベルを操作しても、
そもそもワークフロー実行が作られない。最も広く効いている防御。

### 第2層: Bot 判定（トークン依存）

`claude-issue-dispatch.yml`の`state`ステップ（L165〜）は、`github.event.sender.type`が`Bot`の場合、
原則としてスキップする。`issue-deck[bot]`かつ`issue_comment`イベントのときのみ、アプリが
コメント末尾に埋め込む投稿者マーカー（`<!-- issue-deck:posted-by:<login> -->`）から実際に操作した
人間を復元して権限チェックを行う。

この仕組みは元々`claude-issue-dispatch.yml`のコメント（#173）に明記されていた:

> issue-deck の GitHub App によるラベル更新の操作は GitHub 上 issue-deck[bot] として記録され、
> issues/unlabeled イベント単独では実際に操作した人間を特定できず**前段の権限チェックで
> 自己ループ防止により弾かれる**

すなわち**「エージェント由来のイベントは Bot 属性になる」という前提の上に成り立っていた**。

**#566でラベル操作（`PATCH`/`DELETE /api/issues`）が個人の GitHub OAuth トークン
（`user.githubAccessToken`）経由に変更されたことで、この前提はラベル操作には当てはまらなくなった。**
アプリ画面経由のラベル更新は GitHub 上、操作した本人のアカウントによる`issues/unlabeled`イベントとして
記録されるようになり、`sender.type`は`User`になるため第2層の Bot 判定を素通りする。この場合、第2層は
「実行者の権限確認」としては引き続き機能する（`ACTOR`が本人になるため`gh api .../permission`が本人の
権限で判定される）が、「エージェント自身の操作を無視する」という自己ループ防止の役割はラベル操作の
経路では働かなくなった。

その結果生じる懸念（承認操作時にラベル除去イベントとアプリの確認コメント投稿イベントの両方が実装再開
条件を満たし、ワークフローが二重起動しうる）への対策として、`21.plan-required`保持時（ブランチ未作成の
計画承認・練り直し。ラベル除去イベント単独で`MODE`判定に必要な情報が揃う唯一のケース）に限り、
`src/lib/github/approval-labels.ts`の`approveCommentBody`/`rejectCommentBody`がコメント本文に
`<!-- issue-deck:no-trigger -->`マーカーを付与し、`claude-issue-dispatch.yml`の`issue_comment`
トリガーの`if:`条件がこのマーカー付きコメントを起動対象から除外する（マーカーはワークフロー起動条件の
除外にのみ作用し、コメント自体の投稿・可読性には影響しない）。ブランチ・PR作成後の状態
（`03.d:marge`/`07.m:marge`での「修正を依頼する」等）は、第3層（`BRANCH_EXISTS`ガード）により
ラベル除去イベント単独が`MODE=skip`になるため二重発火の実害が無く、この対策の対象外。

### 第3層: mode 判定（トークン非依存）

`state`ステップの`MODE`決定ロジック。`ISSUE_CLOSED`・`BRANCH_EXISTS`・`PR_STATE`・ラベル状態から
`skip`を返すことで、不正な状態遷移からの再始動を防ぐ。トークン種別に依存しない唯一の層。

## 3. 差し替え（`github.token` → `WORKFLOW_PAT`）のデメリット

### 3-1. `permissions:`ブロックが無効化される

`claude-issue-dispatch.yml`のジョブは`contents: write` / `pull-requests: write` / `issues: write` /
`actions: read` / `id-token: write`と最小権限を宣言している（L114〜）。#497の自己リトライ機構
（フォールバック検証ステップが`gh workflow run`で自分自身を再起動する）は`GITHUB_TOKEN`では
`workflow_dispatch`を発火できないため`secrets.WORKFLOW_PAT`で呼び出しており、`GITHUB_TOKEN`側の
`permissions:`に`actions: write`を追加する必要はない（least privilegeの観点から`actions: read`の
ままにしている）。ただしこの宣言が効くのは**`GITHUB_TOKEN`に対してだけ**であり、PAT 経由の操作は
一切制約を受けない。ワークフローファイル上の least privilege 宣言が形骸化する。

### 3-2. 自己ループ防止の第1層・第2層が同時に無効化される

PAT による操作はイベントを生成する（第1層が消える）。かつ、その`github.actor`は
**`m-guchi`（Bot ではなく User）**になるため、第2層の Bot 判定を素通りし、続く
`gh api repos/.../collaborators/.../permission`による権限チェックも admin なので当然通過する。

**守りが3層から1層（mode 判定のみ）に減る。**

これは後述の 3-4（帰属の問題）と同じ根を持つ。「誰が操作したか区別できなくなる」ことは
監査ログの見た目の問題ではなく、**その区別に依存した実動の安全機構が壊れる**ことを意味する。

#### 実際に何が起きるかの追跡結果

計画ステップの許可リストは以下（`claude-issue-dispatch.yml:395`）。

```
Bash(gh issue view:*), Bash(gh issue comment:*), Bash(gh issue edit:*),
Bash(gh pr list:*), Bash(gh api:*), Bash(git ls-remote:*), Bash(git log:*),
Bash(curl:*), Read
```

このステップを PAT に差し替えた場合、**即時の無限ループは発生しない**。

- 計画コメントの投稿 → `issue_comment: created`は発火するが、ジョブ条件
  `startsWith(github.event.comment.body, '@claude')`に掛からない（計画コメントは
  `## 調査結果と方針`で始まる）ため実行されない
- `gh issue edit --add-label "00.check-user"` → `issues: labeled`が発火するが、dispatch が
  待つのは`unlabeled`のみのため実行されない

エージェント（あるいはインジェクションによる指示）が`00.check-user`を**除去**した場合は以下の
経路をたどる。

1. `issues: unlabeled`（`label.name == '00.check-user'`）が発火 → ジョブ条件を満たす
2. actor が User のため第2層を通過、権限チェックも通過
3. `AWAITING_CONFIRM=false`・`21.plan-required`は残存 → `MODE=plan`
4. 計画ステップが再走し、計画コメントを二重投稿して`00.check-user`を再付与（付与は発火しない）

**二重実行1回で収束し、無限ループにはならない。** Issue クローズ時に`00.check-user`を外す
`issue-labels.yml`の経路も、`ISSUE_CLOSED=true` → `MODE=skip`で止まる。第3層は健在。

ただし`Bash(gh api:*)`は事実上あらゆる GitHub API 操作を許すため、第3層が想定していない状態遷移
（ブランチ作成・PR 作成など）を作られた場合の保証はない。

### 3-3. プロンプトインジェクションの被害範囲が広がる

**インジェクションの入口は現状でも開いている。** issue-deck はパブリックリポジトリで、Issue への
コメントは誰でも投稿できる。計画エージェントは`gh issue view --comments`で全コメントを読むため、
第三者が書いた文字列は今もエージェントのコンテキストに入る。起動には write 権限が必要（`state`
ステップの権限チェック）だが、**注入する文章を仕込むのに権限は要らない**。

PAT への差し替えで変わるのは入口ではなく**成功したときの被害範囲だけ**。許可リストの
`Bash(gh api:*)`・`Bash(curl:*)`は`GH_TOKEN`で任意の API 操作ができる汎用の抜け道であり、
**トークンのスコープがそのまま被害範囲になる（ほぼ1対1で対応する）**。

### 3-4. 操作の帰属が人間になる

PAT はユーザー個人に紐づくため、コメント投稿もラベル操作も監査ログ上は`m-guchi`本人の操作として
記録される。現在は`github-actions[bot]`として明確に区別できているものが失われる。

- エージェントの操作か人間の操作かがログから判別できなくなる
- IssueDeck アプリ側が bot/人間を出し分けている場合、表示に影響する
- 上記 3-2 のとおり、この区別に依存した安全機構が壊れる

### 3-5. レート制限の隔離が失われる

| リポジトリ数 | `GITHUB_TOKEN`の合計上限 | 共有 PAT の合計上限 |
|---|---|---|
| 1 | 1,000 req/時 | 5,000 req/時 |
| 5 | 5,000 req/時 | 5,000 req/時（分岐点） |
| 10 | 10,000 req/時 | 5,000 req/時 |

数値以上に**隔離が消えることが問題**。現在は1リポジトリの暴走ループが他リポジトリの予算を
食うことはないが、共有 PAT では1箇所の暴走が全リポジトリを止める。さらにこの 5,000 は、
同じ PAT を使うローカルの`gh` CLI など**全用途で共有**される。

なお GitHub App のインストールトークンは 5,000 req/時が下限で、インストール規模に応じて
最大 12,500 まで自動的に上がる。

### 3-6. 有効期限が単一障害点になる

`GITHUB_TOKEN`はジョブ終了時に自動失効しローテーション不要。Fine-grained PAT は最長366日の
期限があり、切れると**これを使う全ワークフローが同時に停止する**。使用箇所を増やすほど
影響範囲が広がる。

### 3-7. そもそも Fine-grained PAT はリポジトリを明示追加しないと読めない

`WORKFLOW_PAT`は Fine-grained PAT であり、対象リポジトリを設定画面で明示選択するリスト方式。
`GH_TOKEN`を差し替えるだけでは他リポジトリは読めず、**PAT の設定に対象リポジトリを追加する
操作が別途必要**（classic PAT の`repo`スコープのようにアカウント全体へ一括で効くわけではない）。

これは手間である一方、セキュリティ上は有利な性質であり、代替案 A の前提になる。

## 4. メリット

差し替えで得られるものは、実質的に以下の1点のみ。

- **他リポジトリの読み取りが可能になる**（対象リポジトリを PAT に追加した場合）

副次的に「plan / implement ステップのトークンが揃って理解しやすくなる」「レート制限が
1,000→5,000 になる」があるが、後者は現状の使用量では実質的な意味を持たない。

## 5. 代替案

### 案A: 読み取り専用の別 PAT を新設し、`GH_TOKEN`は据え置く

- 新規 Fine-grained PAT（例: `CROSS_REPO_READ_PAT`）を作成。権限は
  **Contents: Read / Metadata: Read / Issues: Read のみ**、対象リポジトリは調査対象だけに限定
- 既存の`GH_TOKEN: ${{ github.token }}`は**変更せず**、別の env（例: `GH_TOKEN_READONLY`）として
  追加で渡す
- エージェントには他リポジトリ調査時のみ`GH_TOKEN=$GH_TOKEN_READONLY gh api ...`の形で使わせる
  （`Bash(gh api:*)`は既に許可済みのため、許可リストの変更は不要）

書き込み権限がないため、3-2（ループ防止の無効化）・3-4（帰属）は発生せず、3-3 の被害も
「他リポジトリの公開情報を読む」に留まる。3-1 も issue-deck 自身への操作は`GITHUB_TOKEN`のまま
なので維持される。

### 案B: GitHub App のインストールトークンを都度発行する

`actions/create-github-app-token`で、IssueDeck が既に持つ GitHub App から**1時間で失効する**
インストールトークンを実行時に発行する。

- 期限管理が不要（3-6 が解消）
- 帰属は App（Bot）のままなので第2層の Bot 判定が機能し続ける（3-2・3-4 が解消）
- 権限はインストール単位で制御でき、レート制限も 5,000 以上が確保される
- #354 が目指す「IssueDeck 経由で他リポジトリを扱う」方向性と一貫する

App のインストールと権限付与が前提になる。**長期的にはこれが本命。**

#### 前提条件の充足状況（2026-08-11時点、#834）

本案が必要とする権限は、GitHub側のApp設定画面での確認により**既に3つとも付与済み**であることが
確認できた。追加申請もインストール済みリポジトリのオーナー再承認も不要である。

| 権限 | 実際の設定 | 本案での用途 |
|---|---|---|
| `Contents` | Read and write | ファイルの書き換えとbranch push |
| `Workflows` | Read and write | `.github/workflows/`配下への push（既定の`GITHUB_TOKEN`では原理的に不可能な部分） |
| `Pull requests` | Read and write | PR の作成 |

権限一覧の一次情報は[docs/github-app-permissions.md](github-app-permissions.md)の
「実際に付与されている権限（実測）」に置く。**同ドキュメントの棚卸し表は「各機能が必要とする
権限の推定」であって実際の付与内容ではない**ため、権限を前提にした判断ではそちらと混同しない
こと（#834 で実際に誤判断が起きた）。

残る前提は、App ID と秘密鍵を issue-deck リポジトリの Actions Secrets へ登録することのみ
（#834 のやること2）。これが済めば #835（`WORKFLOW_PAT`参照の置き換え）へ着手できる。

なお、issue #622 で遭遇した「リポジトリの Workflow permissions で
『Allow GitHub Actions to create and approve pull requests』が無効だと`gh pr create`が
失敗する」という制限は、既定の`GITHUB_TOKEN`固有のものであり、Fine-grained PAT や
GitHub App のインストールトークンにはこの制限が適用されない（issue #640）。したがって
案B へ移行すれば、このリポジトリ設定を変更しなくても#622 の問題は解消する。

### 案C: 調査フェーズを Actions で行わない（issue #360 で実装予定）

他リポジトリの調査は、人間がループに入れる実行環境（Claude Code のセッション）で実施し、
GitHub Actions 側は issue-deck 自身の実装に閉じたまま据え置く。追加の攻撃面がゼロでコストも最小。

issue #357 の調査は実際にこの方式で完遂した（セッション側でリポジトリを実行時に追加し、
`m-guchi/shopping-list`をクローンして調査した）。

**issue #360「Claudeアプリの画面が開くボタンを追加」がこの方式の実装にあたる。** IssueDeck の
Issue 画面から`https://claude.ai/code/new?branch=develop`形式の URL で Claude Code のセッションへ
遷移し、プロンプトを入力した状態で開始できるようにするもの。

この方式が本ドキュメントの論点に対して優位なのは、**トークンを配置する場所そのものが変わる**ため。
GitHub Actions 上の無人実行では、事前に配置した静的なトークンのスコープが実行時の権限の上限を
決めてしまうため、「調査に必要な広さ」と「無人実行に許してよい狭さ」がトレードオフになる。
一方 Claude Code のセッションは、リポジトリのスコープを**実行時に人間の承認付きで解決する**ため、
このトレードオフ自体が発生しない。結果として:

- 恒久的な広域トークンを Actions 側に配置する必要がなくなる（3-1・3-5・3-6 が発生しない）
- 操作は Actions の外で行われるため、自己ループ防止の3層構造に一切手を入れずに済む（3-2 が発生しない）
- インジェクションが起きても、人間がループにいるため実行前に止まる（3-3 の被害が限定される）

したがって **issue #360 が実現する見込みであれば、案A・案B への投資は不要になる可能性が高い**。
少なくとも「調査フェーズのために Actions のトークンを広げる」という動機は消える。

ただし案C がカバーするのは**人間が起点となる調査・実装フェーズのみ**である点に注意。
`@claude`コメントを起点とする無人実行そのものを他リポジトリへ展開する
（[docs/cross-repo-automation.md](cross-repo-automation.md)の本来の目的）場合は、
連携リポジトリ側の Actions が Claude Code を実行するための認証情報が別途必要になり、
案B（GitHub App のインストールトークン）の検討は引き続き必要になる。

## 6. 比較表

| | 直接差し替え | 案A: 読み取り専用の別PAT | 案B: App トークン | 案C: 据え置き（#360） |
|---|---|---|---|---|
| 他リポジトリ読み取り | ○ | ○ | ○ | ×（Actions 側では） |
| `permissions:`の最小権限が維持される | × | ○ | ○ | ○ |
| ループ防止の第1層・第2層 | **無効化** | 維持 | 維持 | 維持 |
| 操作の帰属 | 人間になる | Bot のまま | Bot のまま | Bot のまま |
| インジェクション成功時の被害範囲 | 複数リポジトリへの書き込み | 対象リポジトリの読み取りのみ | インストール範囲 | 変化なし |
| レート制限 | 全用途で共有・隔離なし | 調査用途のみ共有 | 5,000〜12,500/時 | リポジトリごとに隔離 |
| 期限管理 | 最長366日・切れると全停止 | 同左（影響は調査機能のみ） | 1時間で自動失効 | 不要 |
| 導入コスト | 最小 | 小 | 中（App 設定が前提） | ゼロ |

**単純な差し替えは推奨しない。** 得られるものは「他リポジトリが読める」の1点だけで、その1点は
案A でも同じく得られる上、案A なら失うものがほぼない。

## 7. 未確定・要人間判断の事項

- `WORKFLOW_PAT`の現在の有効期限と、対象リポジトリの選択状況（GitHub の PAT 設定画面でのみ確認可能）
- IssueDeck の GitHub App が保有する権限スコープと、インストール済みリポジトリの一覧
  （案B の実現可能性を左右する。[docs/cross-repo-automation.md](cross-repo-automation.md)の
  「4. GitHub App の権限確認」と同じ論点）
- 案A・案B・案C のいずれを採るか。**案C は issue #360 で実装予定のため、少なくとも
  「人間が起点となる調査フェーズ」については案C で解決する見込み。** そのうえで案A・案B の
  検討が引き続き必要かどうかは、「無人実行そのものを他リポジトリへ展開する」という
  [docs/cross-repo-automation.md](cross-repo-automation.md)本来の目的を追うかどうかで決まる
- トークン設定の変更は CLAUDE.md の自動マージ不可カテゴリ「GitHub Actions やデプロイ設定」
  「Secrets や環境変数」の双方に該当するため、いずれの案を採る場合も`00.check-user`付与＋
  人間レビューが必須
