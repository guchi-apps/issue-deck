# GitHub Actions のトークンモデルと自己ループ防止機構

`.github/workflows/`配下のワークフロー群が使う2種類のトークン（既定の`GITHUB_TOKEN`と
`secrets.WORKFLOW_PAT`）の使い分け、その使い分けが支えている自己ループ防止機構、および
「他リポジトリを読めるようにする」際の選択肢を整理する。

発端は issue #357（他リポジトリでの実現可能性調査）で、GitHub Actions 上の実装エージェントが
`m-guchi/shopping-list`を読み取れず調査を完遂できなかったこと。その原因分析から、
「計画ステップの`GH_TOKEN`を`github.token`から`secrets.WORKFLOW_PAT`へ差し替えれば他リポジトリを
読めるのではないか」という案が出たため、そのメリット・デメリットを検証した。**結論としては
単純な差し替えは推奨しない。** 理由は本ドキュメントの「3. 差し替えのデメリット」を参照。

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
| `claude-issue-dispatch.yml` | `actions/checkout`の`token`（L147）、実装ステップの`GH_TOKEN`と`github_token`（L749・L752）、`mode=additional`時の checkout（L668） | ワークフローファイルへの push、push/PR 作成による`issue-labels.yml`の発火 |
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

### 第1層: GitHub の仕様（トークン依存）

`GITHUB_TOKEN`を使って行った操作は、`workflow_dispatch`・`repository_dispatch`を除き、
**イベント自体が生成されない**。エージェントがコメントを投稿してもラベルを操作しても、
そもそもワークフロー実行が作られない。最も広く効いている防御。

### 第2層: Bot 判定（トークン依存）

`claude-issue-dispatch.yml`の`state`ステップ（L165〜）は、`github.event.sender.type`が`Bot`の場合、
原則としてスキップする。`issue-deck[bot]`かつ`issue_comment`イベントのときのみ、アプリが
コメント末尾に埋め込む投稿者マーカー（`<!-- issue-deck:posted-by:<login> -->`）から実際に操作した
人間を復元して権限チェックを行う。

この仕組みは`claude-issue-dispatch.yml`のコメント（#173）に明記されている:

> issue-deck の GitHub App によるラベル更新の操作は GitHub 上 issue-deck[bot] として記録され、
> issues/unlabeled イベント単独では実際に操作した人間を特定できず**前段の権限チェックで
> 自己ループ防止により弾かれる**

すなわち**「エージェント由来のイベントは Bot 属性になる」という前提の上に成り立っている**。

### 第3層: mode 判定（トークン非依存）

`state`ステップの`MODE`決定ロジック。`ISSUE_CLOSED`・`BRANCH_EXISTS`・`PR_STATE`・ラベル状態から
`skip`を返すことで、不正な状態遷移からの再始動を防ぐ。トークン種別に依存しない唯一の層。

## 3. 差し替え（`github.token` → `WORKFLOW_PAT`）のデメリット

### 3-1. `permissions:`ブロックが無効化される

`claude-issue-dispatch.yml`のジョブは`contents: write` / `pull-requests: write` / `issues: write` /
`actions: read` / `id-token: write`と最小権限を宣言している（L114〜）。しかし**この宣言が効くのは
`GITHUB_TOKEN`に対してだけ**であり、PAT 経由の操作は一切制約を受けない。ワークフローファイル上の
least privilege 宣言が形骸化する。

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

### 案C: 調査フェーズを Actions で行わない

他リポジトリの調査は、人間がループに入れる実行環境（Claude Code のセッション）で実施し、
GitHub Actions 側は issue-deck 自身の実装に閉じたまま据え置く。追加の攻撃面がゼロでコストも最小。

issue #357 の調査は実際にこの方式で完遂した（セッション側でリポジトリを実行時に追加し、
`m-guchi/shopping-list`をクローンして調査した）。

なお、IssueDeck アプリから Claude Code のセッションへ遷移させる機能を別 Issue で検討中であり、
**その構成が実現すれば本ドキュメントの論点の大半は解消する**。セッション側の実行環境は
リポジトリのスコープを実行時に人間の承認付きで解決するため、恒久的な広域トークンを Actions 側に
配置する必要がなくなる。

## 6. 比較表

| | 直接差し替え | 案A: 読み取り専用の別PAT | 案B: App トークン | 案C: 据え置き |
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
- 案A・案B・案C のいずれを採るか。案C（IssueDeck から Claude Code セッションへ遷移する機能）が
  実現する見込みであれば、案A・案B への投資自体が不要になる可能性がある
- トークン設定の変更は CLAUDE.md の自動マージ不可カテゴリ「GitHub Actions やデプロイ設定」
  「Secrets や環境変数」の双方に該当するため、いずれの案を採る場合も`00.check-user`付与＋
  人間レビューが必須
