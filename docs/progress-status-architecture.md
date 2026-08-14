# 進捗管理をGitHub Projectsへ移す設計

**いつ読むか**: Issueの進捗（未着手〜本番反映済）の扱いに関わるコードを触るとき。
進捗をどこから読むべきか（＝Project Status。進捗ラベルはPhase 5で廃止済み）を確かめたいとき。

issue #991 の設計ドキュメント。**この文書が進捗管理の設計の一次情報源**で、各段階のIssueは
ここを参照する（Issue側に設計を複製しない）。

## 背景

issue-deckはIssueの進捗を`01.planning` → `02.wip` → `03.d:marge` → `05.develop` →
`07.m:marge` → `09.main`のラベルで管理してきた。#991は「GitHub Projectsのカンバンで
同じことができないか」という検討で、当初は`m-guchi`がUserアカウントだったため
`projects_v2_item` Webhookが使えず（Organization限定）実現に無理があった。

#996 でOrganization `guchi-apps`への移行が完了し、GitHub Appのインストールトークンで
Projects v2を読み書きできるようになったため前提が整った（経緯は
[organization-migration.md](organization-migration.md)）。

## 決定事項

議論の結果、以下を最終形とする。**この4点が各段階の設計を規定する。**

1. **進捗ラベル（`01.planning`〜`09.main`）は最終的に廃止する。** Statusを唯一の正にする
   （Phase 5・#1010で実施済み）
2. **対象はマルチエージェント対応リポジトリ全体。** `shopping-list`・`dayspan`も同じProjectで管理する
3. **実行基盤はGitHub ActionsとミニPC上のClaude Codeを併用する。** ローカル実行の主目的は
   セッションの保持
4. **privateアプリを統合する段階でGitHub Team（$4/月）へ上げる**

`00.check-user`・`21.plan-required`・`22.merge-confirm-required`・`23.preview-required`・
`24.screenshot-required`・`70.confirm`・`11.local`・Priority系は**ラベルのまま残す**。
Status = 今どこにいるか、Label = どんな性質・条件があるか、という役割分担にする。

### StatusとProgressStatusKeyの対応

| Project Status | `ProgressStatusKey` | かつての進捗ラベル（Phase 5で廃止） |
|---|---|---|
| Ready | `ready` | （進捗ラベル無し） |
| Planning | `planning` | `01.planning` |
| Implementation | `implementation` | `02.wip` |
| Develop PR | `develop-pr` | `03.d:marge` |
| Develop | `develop` | `05.develop` |
| Release | `release` | `07.m:marge` |
| Done | `done` | `09.main` |

対応表の実体は[`src/lib/issue-progress.ts`](../src/lib/issue-progress.ts)の`PROGRESS_STATUSES`
にあり、Status名・表示名・アイコンを1箇所に集約している。**ラベル名の列は履歴であり、
コード上には存在しない**（Phase 5・#1010で削除した）。

### 盤面へ載せるのもissue-deckの仕事

**Project WorkflowsのAuto-addには頼れない。** GitHub Docs
[Adding items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)
のとおり、auto-addワークフローは**1つにつき1リポジトリ**で、数はプランで制限される。

| プラン | auto-add の上限 |
|---|---|
| **Free** | **1** |
| Pro / Team | 5 |
| Enterprise Cloud | 20 |

**Teamへ上げても5リポジトリまで**で、「対象はマルチエージェント対応リポジトリ全体」という
決定事項に届かない（アプリは12個ある）。したがって**アイテムの追加もissue-deckが行う**（#1036。
Phase 4で`dayspan`へ展開する段で判明した）。

これは回避策ではなく、「Projectへの読み書きはissue-deckに一本化する」という中核の判断に
アイテムの追加を含めただけである。載せるタイミングは2つ。

| タイミング | 対象 |
|---|---|
| 進捗報告時（`reportProgressStatus`） | 報告されたIssueが盤面に無ければ載せる |
| 再同期時（`addMissingProjectItems`） | `hasClaudeWorkflow`が真のリポジトリのopenなIssueで、盤面に無いもの |

**再同期の対象を`hasClaudeWorkflow`で絞る**のは、issue-deckが20以上のリポジトリに接続しており
全部を載せると盤面が埋まるため。closedなIssueも追加しない。

**追加直後はStatusを`Ready`にする。** 未設定のままだと、そこからカードを動かしても遷移前が
`Ready`にならず、カンバン起点の起動（Phase 3）が働かない。

`addProjectV2ItemById`は**登録済みなら既存のアイテムを返す**ため、GitHub側のAuto-addを有効に
したままでも重複しない。

### Projectの対象はIssueのみ。PRはアイテムにしない

Auto-addを使う場合は`is:issue`で絞り、**Pull Requestは追加しない。** issue-deck側から載せる
経路はIssueしか扱わないため、そもそもPRは入らない。

- **Statusの7段階がIssueの形をしている。** `Planning`・`Implementation`はPRにとって意味を持たず、
  混ぜると半分の列が片方にとって無意味になる
- **1つのIssueに複数のPRが発生するため、二重計上が倍数で効く。** #991は設計の記録・Phase 1の実装・
  移行記録などで**4本のPR**（#1000・#1001・#1003・#1006）を生んだ。PRをアイテムにすると
  1つの作業単位が5アイテムになり、「一望できる」というカンバンの価値が直接損なわれる
- **PRの情報は既にIssue側に出ている。** issue-deckは`pull-request-link.ts`・`pull-request-ci.ts`・
  `pull-request-timeline.ts`でPRとCIの状態をIssueのカードに表示している。Projectにも
  `Linked pull requests`フィールドがあり、アイテムにしなくても紐づくPRは見える
- `is:issue`を外すと、バージョンbump PR・リリースPR・ワークフロー修正PRまで流れ込む

なお`fetchProjectItem`は`... on Issue`でクエリしているため、**PRが混ざってもnullを返して無視する**
（[`projects-api.ts`](../src/lib/github/projects-api.ts)の`toSnapshot`）。誤って追加されても
壊れないが、Statusを持ったまま盤面に居座ることにはなる。

**隙間として、リリースPR（develop→main）とバージョンbump PRには対応するIssueが無く、盤面に
現れない。** ただしリリースの進捗は「リリースされる側のIssue」が`Release` → `Done`と進むことで
表現されており、リリース作業そのものをアイテムにしていないのは一貫している。

### `Develop PR`・`Develop`は最新のPRの状態であり、Issueの完了ではない

1つのIssueに複数のPRが発生するため、Statusは往復する。

```
Develop PR → Develop →（次のPR）→ Develop PR → Develop → ...
```

**各時点では正確だが、作業が続いているのに`Develop`（develop反映済）で止まって見える期間が
生まれる。** 実際に#991で発生した。PR #1000がマージされた時点で`develop-pr-merged`ジョブが
当時の`05.develop`ラベルを付け、作業を続けるために人が手で外した。**#991でラベルとStatusが
ズレた原因はこれである。**

したがって**`Develop PR`・`Develop`は「最新のPRがどうなっているか」を表すものと定義する。**
「Issueの作業が終わったか」ではない。Issueが終わるのは`Done`（本番反映）のときだけ。

この定義なら往復は正常な挙動であり、盤面も嘘をつかない。「Develop列にあるがIssueはopen」は
「直近のPRは反映済みだが作業は継続中」と読む。

Phase 2でActionsから進捗を報告する際も、**PRのマージをもって`Develop`にするのが正しい**。
Issueの完了判定をそこへ持ち込まない。

## 目標アーキテクチャ

```
        人間（カンバンをドラッグ / issue-deckのボタン）
                      │
                      ▼
        GitHub Projects（Status = 進捗の唯一の正）
              ▲                    │
   ② Statusを更新                  │ ③ projects_v2_item Webhook
      （Appトークン）               ▼
        ┌──────────  issue-deck  ──────────┐
        │       状態の唯一の出入口            │
        │  ①報告を受ける      ④ジョブを配る   │
        └────▲──────────────────┬──────────┘
             │                  │
    ┌────────┴────────┬─────────┴────────┐
    │  GitHub Actions │  ミニPC           │
    │  claude-code-   │  Claude Code      │
    │  action         │  （セッション保持） │
    └─────────────────┴───────────────────┘
```

### 中核の判断：Projectへの読み書きはissue-deckに一本化する

実行基盤が直接Projectを更新するのではなく、**issue-deckのAPIへ報告し、issue-deckがProjectを
書く**。理由は3つ。

- **権限の配布が1箇所で済む。** Projects v2の書き込み権限を持つのはissue-deckのGitHub Appだけで
  よく、他リポジトリのワークフローにもミニPCにも配らない。対象リポジトリが増えても増えるのは
  「issue-deckのAPIを叩く」ことだけ
- **人間の操作と機械の更新を区別できる。** Projectを書くのが常にissue-deckのAppなので、
  `projects_v2_item`の`sender`が自分なら無視できる。これがPhase 3で「自分の書き込みで自分が
  起動する」のを防ぐ唯一の手段になる。各ワークフローが`WORKFLOW_PAT`（所有者は人間の`m-guchi`）
  で直接書くと、人間のドラッグと見分けがつかず成立しない
- **実行基盤を差し替えられる。** ミニPC側も同じAPIへ報告すればよく、Projectsの認証を持たせずに
  済む。#991のコメントにある`ExecutionProvider`の実体がこのAPIになる

**前例がある。** `reusable-issue-dispatch.yml`は既に`$APP_BASE_URL/api/settings/claude-model`を
curlで叩き、疎通失敗時は警告を出してフォールバックする作りになっている。同じ流儀を使う。

### 受け入れるリスク

- **issue-deckが進捗更新の単一障害点になる。** 呼び出し側は失敗してもワークフローを止めない。
  ズレは再同期で是正できるようにしておく
- **書き込みAPIには認証が要る。** `CI_LOGIN_BYPASS_SECRET`は本番で無効化される作り
  （[`src/lib/ci-auth-bypass.ts`](../src/lib/ci-auth-bypass.ts)）のため転用できない。専用の
  共有シークレットをorganization secretとして持つ

## 段階

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 読み取りをStatus優先に。`resolveProgressStatus`へ集約 | ✅ 完了（v2.12.0・PR #1003） |
| 2 | 進捗報告APIを作り、issue-deckがProjectを更新する（ラベルと併走） | ✅ 実装済み（#1007） |
| 3 | 起動をStatus起点にする。カンバンのドラッグで実行が始まる | ✅ 実装済み（#1008） |
| 4 | `shopping-list`・`dayspan`へ展開 | ✅ 完了（#1009。残りのリポジトリは #1047） |
| 5 | 進捗ラベルを廃止 | ✅ 実装済み（#1010） |
| 6 | privateアプリを統合（**この時点でTeamへ上げる**） | |

**Phase 5を後半に置いたのは、ラベルが安全網として機能していたため。** Statusが壊れてもラベルが
あれば`resolveProgressStatus`がフォールバックできた。**Phase 5でその保険は無くなった。**
Projectへ載っていないリポジトリのIssueは、issue-deckの画面で一律「未着手」に見える
（盤面へ載る条件は`hasClaudeWorkflow`）。#1047 の展開が終わるまでこの状態が続く。

### Phase 1（完了）

進捗の判定を[`src/lib/issue-progress.ts`](../src/lib/issue-progress.ts)の
`resolveProgressStatus`へ集約し、**Project Statusがあればそれを優先、無ければ進捗ラベルへ
フォールバック**する形にした。これが #991 のスコープ項目5「実行環境に依存しない状態管理
インターフェース」の実体で、GitHub Actionsから更新されようとミニPCから更新されようと、
読む側は同じ入口を通る。

Statusは`projects_v2_item` Webhookと再同期（[`sync-project-status.ts`](../src/lib/github/sync-project-status.ts)）で
`Issue.projectStatus`へ入る。Projects v2はGraphQLのみのため境界は
[`projects-api.ts`](../src/lib/github/projects-api.ts)。

**ナビゲーションビューの絞り込みはこの段階ではラベルベースのまま据え置いた。** 二重運用中は
両者が一致するため実害が無く、`filterIssuesByView`のラベル配列マッチを状態ベースへ変える改修は
影響範囲が広いため。Phase 5（#1010）で移した。

### Phase 2（実装済み）

**進捗報告API `POST /api/progress` を作り、Projectへの書き込みをissue-deckへ一本化した**（#1007）。

```
ワークフロー / ローカル実行
        │  POST /api/progress
        │  {"repository":"owner/name","issue":1007,"status":"implementation"}
        ▼
   issue-deck（Appトークン）
        │  updateProjectV2ItemFieldValue
        ▼
   GitHub Projects の Status
```

- **受け取るのは`ProgressStatusKey`**（`implementation`等）で、ラベル名でもStatus名でもない。
  ラベルを廃止するPhase 5で呼び出し側を書き換えずに済ませるため
- **認証は共有シークレット`PROGRESS_REPORT_SECRET`**（[`progress-report-auth.ts`](../src/lib/progress-report-auth.ts)）。
  呼び出し側は無人実行でログインセッションを持てない。GitHub側にはorganization secretとして置く
- **StatusフィールドのidとoptionのidはProjectごとに異なる**ため環境変数に持てず、実行時に
  `PROJECT_V2_OWNER`・`PROJECT_V2_NUMBER`から引く（10分キャッシュ）
- **Projectに未登録のIssueは、issue-deckが自分で盤面へ載せてからStatusを書く**（#1036。当初は
  Project WorkflowsのAuto-addに任せる方針だったが、後述のプラン制限により成立しなかった）
- **アイテムの特定はDBの`projectItemId`ではなくGitHubへ問い合わせる。** 報告の正しさをDBの鮮度に
  依存させないため（Projectへ追加された直後でWebhookが未到達でも正しく更新できる）
- 反映されなかったケース（Project未導入・未登録・変化なし）も**200で理由を返す**。呼び出し側に
  とってはエラーではないため

報告する側は次のとおり。**すべて失敗してもジョブを落とさない**（issue-deckを単一障害点にしない）。

| 遷移 | 報告元 | `status` |
|---|---|---|
| 計画着手 | `reusable-issue-dispatch.yml`（mode=plan） | `planning` |
| 実装着手 | `reusable-issue-dispatch.yml`（mode=implement/additional）・`reusable-issue-labels.yml`（push） | `implementation` |
| develop向けPR作成 | `reusable-issue-labels.yml`（PRオープン）・`reusable-issue-dispatch.yml`（実装ステップ後の実態合わせ） | `develop-pr` |
| developへマージ | `reusable-issue-labels.yml`（PRマージ・sweep） | `develop` |
| main向けPRオープン | `reusable-issue-labels.yml` | `release` |
| mainへマージ | `reusable-issue-labels.yml` | `done` |

**Issueのクローズ（`cleanup-on-close`）は報告しない。** ここで`ready`を報告すると、
`Done`のIssueを人が閉じ直しただけで盤面が巻き戻る。

> **Phase 5（#1010）で削除した経路**: Phase 2には「手で付け替えたラベルもStatusへ反映する」
> （#1042。`issues` Webhookの`labeled`・`unlabeled`起点）と「再同期がラベルを正としてStatusへ
> 書き戻す」（`reconcileProjectStatusesFromLabels`）の2つがあった。どちらも**ラベルが正で
> Statusがその写し**という二重運用期の前提に立つもので、ラベルの廃止で写し元そのものが
> 無くなったため削除した。報告の取りこぼしはGitHub側の盤面を直接直すか、同じ遷移をもう一度
> 起こして回収する。

#### 前提となる設定

| 設定 | 場所 | 未設定時 |
|---|---|---|
| `PROGRESS_REPORT_SECRET` | 1Password → issue-deckの`.env`（`deploy.yml`が配る） | APIが503を返す |
| `PROGRESS_REPORT_SECRET` | organization secret（ワークフロー側） | 報告ステップがスキップ |
| `APP_BASE_URL` | organization/repository変数 | 報告ステップがスキップ |
| GitHub Appのorganization permission **Projects: Read and write** | GitHub App設定 | 書き込みが403 |

**Appの権限はPhase 1（読み取りのみ）から一段上がる。** `Read`のままだと
`updateProjectV2ItemFieldValue`が`Resource not accessible by integration`で失敗する
（[`projects-api.ts`](../src/lib/github/projects-api.ts)がこの文言を検出してヒントを添える）。

#### 有効になるのはmainへのリリース後

報告先の`/api/progress`は**本番へデプロイされて初めて存在する**。`APP_BASE_URL`は本番を指しており、
developへマージしただけでは報告は届かない。またシークレットを本番の`.env`へ配るのは
`deploy.yml`（mainへのpushで動く）なので、**ワークフロー側の設定が揃っていてもリリース前は
HTTP 404、直後の一瞬は503になりうる**。

いずれも警告に留まりジョブは成功するため実害は無く、**リリース後の最初の遷移から自然に効き始める**。
リリース前に進んだぶんのズレは再同期ボタンで回収できる。

### Phase 3（実装済み）

**カンバンでStatusを動かすと実行が始まる。** 起動経路は2つあるが、**起動するかどうかの判定は
[`project-status-dispatch.ts`](../src/lib/github/project-status-dispatch.ts)の1箇所に集約**した。

```
[実装を開始ボタン] → オプションラベル → Status → @claudeコメント（投稿者＝操作した人間）
                                    ↓ 直後に来るApp由来のWebhookは無視する
[カンバンのドラッグ] → Webhook（sender＝人間）→ issue-deck → @claudeコメント（投稿者＝App）
```

起動対象は次の3つだけ。

| 遷移 | 条件 | 実行 |
|---|---|---|
| `Ready → Planning` | — | 計画提示 |
| `Ready → Implementation` | — | 実装 |
| `Planning → Implementation` | `00.check-user`＋`21.plan-required`（＝計画の承認待ち） | 計画を承認して実装 |

- **途中の段階からの移動を無条件には拾わない。** 拾うと**Phase 2の進捗報告そのものが実行の
  再起動になる**。`Planning → Implementation`だけ例外にできるのは、承認待ちラベルの有無で
  「人が承認した」と「機械が報告した」を区別できるため（#1020）
- **後戻りには何も割り当てない。** 実行のキャンセルを割り当てるとStatusを書き戻す処理と
  往復しうるうえ、ドラッグの誤操作で実行が止まる影響が大きい
- **`from`が`null`（盤面へ載せた直後）も対象外。** 載せる操作自体が実行の開始になってしまう
- **`sender`がissue-deckのGitHub Appなら起動しない。** これが無いと、Actionsが
  `implementation`を報告するたびに実装が再起動する
- **`11.local`が付いていれば起動しない**（ローカルセッションで対応中。#919と同じ方針）
- closedなIssueでは起動しない

#### コメント投稿者を変えない（設計上の分岐点）

当初は「ボタンもStatusだけ書き、コメント投稿はWebhookへ一本化する」案だったが、
**`reusable-issue-dispatch.yml`が`@claude`コメントの投稿者のwrite権限を検証している**ため
成立しない。ボタンがAppトークンでStatusを書くと`sender`がAppになり、自己ループ防止のルールで
自分の操作を無視してしまう。

そこで**判定だけを共通化し、コメントの投稿者は経路ごとに変えない**形にした。

| 経路 | コメントの投稿者 | ワークフロー側の権限検証 |
|---|---|---|
| ボタン | 操作した人間（従来どおり） | `github.actor`＝人間。そのまま通る |
| ドラッグ | issue-deckのGitHub App | `<!-- issue-deck:posted-by:<sender.login> -->`から人間を復元して検証 |

投稿者マーカーは**必ず本文の末尾**に置く。ワークフローが`grep -oP ... | tail -n1`で読むため、
本文中に偽のマーカーが混ざっても最後のものが優先される。

**権限のチェックは2系統ある。** 投稿者マーカーが効くのはワークフロー自身の検証だけで、
`claude-code-action`は**コメント本文を見ず`github.actor`だけで**非人間アクターを拒否する
（`checkHumanActor`）。そのため各`claude-code-action`ステップに`allowed_bots: "issue-deck[bot]"`が要る。

| 検証 | 見るもの | マーカーで復元できるか |
|---|---|---|
| `reusable-issue-dispatch.yml`のtriage | `github.actor` ＋ コメント本文 | できる |
| `claude-code-action`の`checkHumanActor` | `github.actor`のみ | **できない** |

これを落とすと**ドラッグ起点の実行が必ず1回失敗する**。しかも自動リトライ（#497）は
`workflow_dispatch`起動で`github.actor`が人間になるため通ってしまい、「実装はできているのに
毎回1回無駄になり、Issueに再実行のノイズが残る」という分かりにくい壊れ方をする（#1022で実際に発生）。

**画面上は起動コメントを操作者本人のコメントとして表示する**（#1026）。同じ`@claude`コメントを
ボタンから投稿すると本人名義になるため、起動経路で見た目が変わらないようにするもの。投稿者は
`posted-by`マーカーから解決するが、**GitHub上の投稿者がissue-deck自身のGitHub Appである場合に
限って信用する**（パブリックリポジトリでは誰でも偽のマーカーを付けられるため）。判定は
[`issue-mapper.ts`](../src/lib/github/issue-mapper.ts)の`resolveCommentAuthorLogin`。

#### コメントより先にラベルを整える

**ワークフローのmodeはコメント本文ではなくラベルで決まる**
（`reusable-issue-dispatch.yml`の「実行モードを決める」ステップ）。したがって意図した実行を
通すには、コメントより先にラベルを整える必要がある。

| mode | ラベル操作 | 落とすとどうなるか |
|---|---|---|
| `plan` | `21.plan-required`を**付ける** | 計画のつもりが実装が始まる |
| `approve-plan` | `00.check-user`・`21.plan-required`を**外す** | 承認したのに計画がやり直される |

**承認はラベルを外すことで表現される。** 両方が外れた状態がワークフローにとっての「承認済み」で、
直前の計画コメントの`<!-- issue-deck-plan-type:implement\|split -->`マーカーに従って実装または
サブIssue分割へ進む。issue-deckの「計画を承認」ボタンと同じ経路。

**ただし`<!-- issue-deck:no-trigger -->`マーカーは付けない。** ボタンは個人のOAuthトークンで
ラベルを外すため`issues.unlabeled`イベントが正規の引き金になり、コメントとの二重起動を防ぐために
このマーカーを付ける（#566）。一方こちらはAppトークンで外すため、そのイベントは自己ループ防止で
無視される（マーカーによる操作者の復元は`issue_comment`にしか効かない）。**引き金になるのは
コメントだけ**なので、付けるとどちらの経路でも起動しなくなる。

#### 二重起動はDBの比較更新で防ぐ

Webhookの再配信・同時配信に対しては、**遷移前のStatusを条件に含めた更新**（compare-and-set）で
防ぐ。実際に状態を進めた1回だけが`count > 0`になり、それ以外は以降の処理へ進まない。

マーカーコメントの有無で防ぐ案もあったが、`Done`まで進んだIssueを`Ready`へ戻して再度動かす場合に
古いマーカーが残っていて起動できなくなる。**遷移そのものを一度きりの資源として扱うほうが正確。**

#### 「起動待ち」表示

`Planning`・`Implementation`にいるのにGitHub Actionsの実行が1つも紐づいていない状態を
ステップバッジに「（起動待ち）」と出す（[`workflow-status-steps.tsx`](../src/components/dashboard/workflow-status-steps.tsx)）。
ドラッグ起点の起動はWebhookの到達に依存するため、届かなかったことを画面から見えるようにする。
判定材料は`/api/issues/workflow-running`が返す`runId`で、専用の状態は持たない。

### Phase 5（実装済み）：進捗ラベルを廃止しStatusを唯一の正にする

**進捗ラベル（`01.planning`〜`09.main`）を廃止した**（#1010）。Phase 1〜4はラベルとStatusの
二重運用で、ラベルが「Statusが壊れても表示を失わない」安全網になっていた。Phase 5はその保険を
外し、Statusだけを判断材料にする段階である。

`00.check-user`・`21.plan-required`・`22.merge-confirm-required`・`23.preview-required`・
`24.screenshot-required`・`70.confirm`・`11.local`・Priority系は**ラベルのまま残る**。
Status = 今どこにいるか、Label = どんな性質・条件があるか、という役割分担は変わらない。

#### 変わったこと

| 対象 | Phase 4まで | Phase 5以降 |
|---|---|---|
| `resolveProgressStatus` | Status優先・無ければラベル | **Statusのみ**。無ければ`ready` |
| ナビゲーションビューの絞り込み | ラベル配列のOR一致 | `LabelFilterPreset.statuses`（`ProgressStatusKey`のOR一致） |
| `reusable-issue-labels.yml` | ラベル付け替え＋Status報告 | **Status報告のみ**（`00.check-user`の除去だけラベル操作が残る） |
| 対象issueの検索（sweep・リリース） | `gh issue list --label "05.develop"` | `GET /api/progress?...&status=develop` |
| 実行モードの判定（dispatch） | `02.wip`・`03.d:marge`の有無 | `GET /api/progress?...&issue=N`の`status` |
| 再同期の是正 | ラベル → Status（`reconcileProjectStatusesFromLabels`） | **無し**（写し元が存在しない） |
| 手動ラベル付け替えの追従（#1042） | ラベル → Status | **無し**（同上） |

#### 進捗の問い合わせAPI `GET /api/progress`

ラベルを外した結果、**「いま何がどの段階にあるか」をGitHubのラベルから知る手段が無くなった。**
探し先はProjectしかなく、Projectへの読み書きはissue-deckへ一本化する（上記「中核の判断」）
ため、書き込みの`POST`と対になる読み取りの入口を作った。認証は同じ`PROGRESS_REPORT_SECRET`。

| 形 | 返すもの | 使う側 |
|---|---|---|
| `?repository=owner/name&issue=123` | `{ status: "implementation" \| null }` | `reusable-issue-dispatch.yml`の実行モード判定 |
| `?repository=owner/name&status=develop,release` | `{ issues: [12, 34] }`（openのみ・昇順） | `develop-merge-sweep`・`main-pr-in-progress`・`main-pr-merged`・`release-develop-to-main.yml` |

実体は[`query-progress.ts`](../src/lib/github/query-progress.ts)。書き込み側と同じく
**DBの`projectStatus`ではなくGitHubへ問い合わせる**（判定の正しさをDBの鮮度に依存させないため）。

#### ラベル定義の削除はリリース後に行う

コードの入れ替えとラベル定義の削除は**同時にできない**。本番へ反映されるまでの間、
稼働中のワークフロー（`reusable-issue-dispatch.yml`の実行モード判定・
`reusable-issue-labels.yml`の対象issue検索）はまだラベルを参照している。先に消すと、
進行中のIssueの追加対応（`mode=additional`）やdevelop→mainの一括遷移が動かなくなる。

順序は次のとおりで、手順は[`scripts/remove-progress-labels.sh`](../scripts/remove-progress-labels.sh)
にまとめてある（既定はdry-run・対象はissue-deckのみ）。

1. #1010 を develop → main へリリースし、本番へデプロイする（`GET /api/progress`が生える）
2. 本番で疎通を確認する。`GET /api/progress`が**405なら未反映・401なら反映済み**
3. `scripts/remove-progress-labels.sh --apply` を実行する（issue-deckのラベルだけ消える）

**他リポジトリ（`dayspan`・`shopping-list`）は同時に対応しなくてよい。** あちらのcallerは
`workflows/v8`にタグ固定されており、issue-deckの`develop`/`main`を進めても影響を受けない。
ラベルもあちらのリポジトリに残ったままなので、v8のワークフローは今までどおりラベル遷移と
Status報告の両方を行う。新しいタグ（`workflows/v9`）を切ってcallerを更新したあとで、
そのリポジトリのラベルを個別に消す（`--repo dayspan`）。

**リリース直後の一括close（`main-pr-merged`）は1回だけ空振りしうる。** develop→mainのマージで
`deploy.yml`（本番反映）と`main-pr-merged`が同時に走り、後者が対象issueを引きに行く時点では
まだ`GET /api/progress`が生えていない可能性がある。**このリリースまではラベルが残っている**ため、
古い版のワークフローが動けば従来どおり成立する。空振りした場合はデプロイ完了後に該当runの
`main-pr-merged`ジョブを再実行すれば回収できる。

#### 受け入れたリスク（Phase 5で増えたもの）

- **issue-deckへ届かない間、リリース時の一括遷移が止まる。** `main-pr-merged`は対象issueを
  1件も見つけられず、issueがcloseされない。Phase 4まではラベルで探しており、issue-deckに
  依存せず完結していた。取りこぼした場合はissue-deckの復旧後にrunを再実行する
- **盤面に載っていないリポジトリのIssueは一律「未着手」に見える。** ラベルという代替の表示元が
  無いため。#1047 の展開が終わるまで続く
- **ローカルセッション（`scripts/start-issue.sh`・`scripts/generic-start-issue.sh`）は
  `APP_BASE_URL`・`PROGRESS_REPORT_SECRET`が見つからないと進捗を進められない。** 探索順は
  環境変数 → 本体の`.env.local` → `~/.config/issue-deck/dispatch.env`（#1236。
  [scripts/lib/progress-report.sh](../scripts/lib/progress-report.sh)）。どこにも無い場合は
  スクリプトが案内を出し、issue-deckの画面（カンバン・「実装を開始」ボタン）から進める

### Phase 6：privateリポジトリ統合時にGitHub Teamへ上げる

privateアプリ（`ops-dashboard`・`vps`・`db-console`・`clip-hive`）を統合する際、GitHub Freeの
制約に2つ同時にぶつかる。

- **organization secretをprivateリポジトリから参照できない**（GitHub Docs
  [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)）。
  上記の共有シークレットが届かない
- **privateリポジトリでブランチ保護が使えない**ため`gh pr merge --auto`が成立せず、最後の
  マージが毎回手動になる

Free前提の分岐（repo secretを配る・auto-mergeを諦める）を設計に持ち込まず、**Teamへ上げることを
前提とする**。費用対効果は[organization-migration.md](organization-migration.md)で「privateを
無人運用へ載せたくなった時点でCへ上げる」と整理済みで、まさにその時点にあたる。

## 実行モードは4つある

実行基盤は「Actions か ローカルか」の二択ではない。**必要なインターフェースがモードごとに違う**
点が設計上重要になる。

| モード | 起動 | セッション | 常時性 | 必要なインターフェース |
|---|---|---|---|---|
| GitHub Actions | issue-deckがディスパッチ | 保持しない | 常時 | 報告のみ |
| ミニPC（常駐） | issue-deckがディスパッチ | 保持する | 常時 | ディスパッチ受け口＋報告 |
| メインPC（VS Code） | **人がその場で開始する** | 保持する | 断続的 | **報告のみ** |
| Claudeアプリ（`claude.ai/code`） | **人がその場で開始する** | 保持する | 常時（PC不要） | **報告のみ** |

**ディスパッチできるのは上2つだけ。** 下2つは人が開いた時点で始まる引き取り型で、開いていない
セッションへジョブを送ることはできない。したがって必要なのは**進捗の報告だけ**である。

裏を返すと、**Phase 2の報告APIは4モードすべてに効く**。ディスパッチ（Phase 3・ミニPCのIssue）は
モードごとに別々でよいが、**報告は共通化する価値が最も高い**。ここが実行基盤に依存しない
インターフェースの核心にあたる。

### 下2つは既に運用されている

- **メインPC（VS Code）**: [`scripts/start-issue.sh`](../scripts/start-issue.sh)がworktreeを作り
  Claude Codeセッションを起動する。`11.local`ラベルを付けている間は`claude-issue-dispatch.yml`が
  そのIssueに対して何もしない（[multi-agent/branching.md](multi-agent/branching.md)）
- **Claudeアプリ**: [`claude-app.ts`](../src/lib/github/claude-app.ts)がIssueを指定して
  `claude.ai/code/new`を開くURLを組み立てる。`branch`に`issue-<番号>`を渡すため、無人実行と
  同じブランチを起点にセッションが始まる（#499）。Actions無人実行との役割分担は #993 で検討中

**現状、これらのモードで進捗を動かすと、ラベルを人が手で付け替えることになる。** 報告APIが
できれば、どのモードから実装しても同じようにカンバンが追従する。

## ローカル実行の主目的はセッションの保持

GitHub Actionsは実行のたびにまっさらなプロセスが立ち、計画・実装・CI修正がそれぞれ独立する。
毎回Issue本文を読み直し、`.shared-context/`をcheckoutし直し、コードを読み直すため、トークンと
待ち時間を消費する。

**self-hosted runnerではこれは解決しない。** ワークフローは毎回新しく起動し
`claude-code-action`も新しいプロセスになる。温まるのはマシン（キャッシュ・worktree）だけで、
会話の文脈は毎回捨てられる。

セッションを保つには**ミニPC上に長時間生きるプロセス**が要る。既存の
[`scripts/run-issue-session.sh`](../scripts/run-issue-session.sh)が「Issue専用worktree＋
開発サーバー＋Claude Codeセッション」を1本のプロセスとして起動しており、部品は揃っている。
現在はフォアグラウンドで1回きりの実行なので、セッションを生かしたまま次の指示を受け取る構造への
作り替えが要る（`claude --resume`）。

振り分けには既存の`11.local`ラベルが使える。付いている間は`claude-issue-dispatch.yml`が
そのIssueに対して何もしない仕組みが既にある（[multi-agent/branching.md](multi-agent/branching.md)）。

方式の詳細設計は規模が別なので専用のIssueで扱う。

## developの一部だけをリリースすることはできない

`develop → main`はブランチ丸ごとのマージで、developにあるものはすべてmainへ行く。
チェリーピックで一部だけ持っていくと、同じ内容でSHAの違うコミットができてmerge-baseがずれ、
以後のリリースで**見かけ上のコンフリクトが多発する**（squash mergeで2回発生した問題と同じ構造。
`.claude/skills/release-to-main/SKILL.md`に記録あり）。

**選択性はブランチではなくフィーチャーフラグで確保する。** Phase 1で導入した
`PROJECT_V2_OWNER`・`PROJECT_V2_NUMBER`（未設定なら連携しない）がその実例で、「マージするか」と
「有効にするか」を分離できている。以降の機能追加も同じ方針を取る。

## 参考リンク

- GitHub Docs: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- GitHub Docs: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)（`projects_v2_item`）
- GitHub Docs: [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)（organization secretのプラン制約）
- 関連ドキュメント: [organization-migration.md](organization-migration.md)（Organization移行の判断材料）・[code-map.md](code-map.md)（データの流れ）
