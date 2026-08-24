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
| Closed | `closed` | （対応する進捗ラベルは無い。#1856で追加） |

対応表の実体は[`src/lib/issue-progress.ts`](../src/lib/issue-progress.ts)の`PROGRESS_STATUSES`
にあり、Status名・表示名・アイコンを1箇所に集約している。**ラベル名の列は履歴であり、
コード上には存在しない**（Phase 5・#1010で削除した）。

**`Closed`（対応終了）だけは`Ready` → `Done`の本流から外れた終端**で、PRを経ずに終わった
Issueのcloseで入る（後述「closeは終端`Closed`への遷移として扱う」）。ステップ表示
（`ADVANCED_PROGRESS_STATUSES`／`WORKFLOW_STEPS`）には含めない。含めると通常のIssueの表示まで
「実装中（2/7）」のように分母が増え、到達し得ない段が常に1つ残るため。

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

#### ただしclosedなIssueは`Done`より手前へ戻さない（#1348）

上の往復が成立するのはIssueがopenの間だけ。**closedなIssueが`Develop`へ戻ると、そこから
二度と`Done`へ戻れない。**

- `develop-pr-merged`（`.github/workflows/reusable-issue-labels.yml`）はブランチ名
  `issue-<番号>`だけを見て`develop`を報告する。Issueの開閉は見ていない
- リリース時に`Release`・`Done`へ一括遷移させる対象を引く`queryIssuesByProgressStatus`
  （`GET /api/progress?status=...`）は、**openなIssueしか返さない**

したがって`Done`でcloseされた後に同じブランチからdevelopへPRがマージされると、Statusだけが
`Develop`へ巻き戻り、以降どれだけリリースを回してもそのIssueは拾われない。#1181が実際にこうなり、
リリース確認ダイアログの「今回反映する内容」に永久に並び続けた（#1348）。

対処は2か所に入れてある。

- **書き込み側**: `reportProgressStatus`が、closedなIssueに対する`done`以外の報告を
  `reason: "issue_closed"`で捨てる。`done`だけ通すのは、`main-pr-merged`が
  「closeしてから`done`を報告する」順序で動いているため
- **表示側**: リリース確認ダイアログの一覧・件数バッジは`isNextReleaseIssue`・
  `isReleasePendingIssue`（`src/lib/issue-progress.ts`）を通し、closedなIssueを除く。
  一括遷移の対象（openのみ）と画面の見え方を揃える

**`Done`のIssueへ追加作業が必要になった場合は、新しいIssueを立てる。** closeされたIssueへ
作業を積み増すと、そのdevelopの変更はどのリリースの対象一覧にも出てこない。

#### `develop`を持たないリポジトリでは`main`宛のPRが遷移を担う（#1901）

上の遷移はすべて「作業ブランチ → `develop` → `main`」を前提にしており、
`reusable-issue-labels.yml`のジョブは`base.ref == 'develop'`か`head.ref == 'develop'`の
どちらかを必ず見る。**`guchi-apps/docs`のように`develop`を置かないリポジトリでは、PRが
`issue-<番号>` → `main`の形にしかならないため、どのジョブも発火しない。**
`Implementation`から先へ進む経路が1つも無く、内容が`main`へ反映された後もIssueが
盤面の「実行中」に残り続けた（guchi-apps/docs#3）。

`workflows/v23`で足した2ジョブがこの形を拾う。

| ジョブ | 発火条件 | 報告 |
| --- | --- | --- |
| `main-direct-pr-opened` | `base.ref == 'main'` かつ `head.ref` が `issue-<番号>`・`opened` | `develop-pr`（＋`00.check-user`・`01.check-merge`の付与） |
| `main-direct-merged` | 同左の`closed` かつ `merged == true` | `done`（＋確認系ラベルの除去・issueのclose） |

- **既存の11リポジトリの挙動は変わらない。** develop運用では作業ブランチが`main`を直接
  狙うことが無く、`if:`の条件に一致しない
- **`claude-review-develop.yml`は`base: main`のPRを判定しない**（callerのトリガーが
  `branches: [develop]`固定）。したがってこのPRは必ず人がマージする前提で、
  `main-direct-pr-opened`は経路の有無を調べず常に`00.check-user`を付ける
- **定期実行の安全網は無い。** 取り残しの巡回（後述「取り残しの回収はissue-deck側の巡回が担う」）が
  見るのは`base: develop`のマージ済みPRだけで、main直行の取りこぼしは拾えない。`docs`は自動マージの経路を持たず人が手でマージする
  ため`pull_request: closed`は確実に発火するが、報告が5xxに当たり続けた場合は画面の
  「進捗」セレクトで直す
- **拾い直せない以上、巻き戻す側を先に塞いである。** `wip-on-push`のマージ済み判定が
  `base.ref == 'main'`も見る（前節）。ここがdevelop決め打ちのままだと、runの作成が遅れた
  pushが`Done`を`Implementation`へ戻し、そのまま誰も拾わない

#### push起点の報告は、runの作成が遅れるとマージ済みのIssueを巻き戻す（#1511）

**ワークフローの報告順は、イベントの発生順ではなくGitHubがrunを作った順で決まる。**
`wip-on-push`（`.github/workflows/reusable-issue-labels.yml`）は`issue-<番号>`ブランチへの
pushで`implementation`を報告するが、このrunの作成が遅れると、既に先へ進んだStatusを
後から上書きする。

#1503で実測した並び。

| 時刻(UTC) | 出来事 | 報告 |
| --- | --- | --- |
| 07:48:41 | `issue-1503`へpush | （runの作成が遅延） |
| 07:49:19 | develop向けPR #1507 をopen | `develop-pr` |
| 07:51:35 | PR #1507 をdevelopへマージ | `develop` |
| 07:59:29 | 07:48:41のpushのrunがようやく作られる | **`implementation`** |

**この巻き戻りは、当時どの安全網でも戻せなかった。** `develop-merge-sweep`が拾い直すのは
`Develop PR`にいるIssueだけで、`Implementation`は対象外だったため。リリース時の一括遷移
（`Develop`・`Release`を`Done`へ）も拾わず、マージ済みのIssueが実装中の列に残り続けた
（#1861で`develop-merge-sweep`が`Implementation`も見るようになり、現在はこの経路でも拾える。
次節を参照）。

対処は`wip-on-push`側に入れてある。**pushされたコミットを先端とする、同じブランチから
`develop`または`main`へのマージ済みPRが既にあれば報告しない。** `.head.ref`まで見るのは、
developの先端から切ったブランチをコミット前にpushした場合を巻き込まないため（そのSHAはdevelopの
マージコミットでもあるため、ブランチ名を見ないと「マージ済み」と誤判定する）。マージ後の追加対応で
pushされた新しいコミットにはマージ済みPRが紐づかないので、`Develop` → `Implementation`という
正規の戻り（`reusable-issue-dispatch.yml`の`mode=additional`）は妨げない。

**`main`も見るのは、main直行リポジトリで同じ巻き戻りが起きるため**（#1901。当初は
`.base.ref == "develop"`の決め打ちだった）。そちらのマージ済みPRは`base.ref == 'main'`なので、
developだけを見ていると常に「マージ済みでない」と判定し、遅れて走った`wip-on-push`が
`main-direct-merged`の`Done`を`Implementation`へ巻き戻す。**しかも`develop-merge-sweep`は
`--base develop`固定で拾い直せない。** develop運用のリポジトリでは`issue-<番号>` → `main`のPRを
作らないため、条件を緩めても挙動は変わらない。

**報告の成否はHTTPコードだけでは分からない点にも注意する。** `POST /api/progress`は
反映されなかった場合（Project未導入・盤面へ未登録・既に同じStatus）も200で
`{"applied": false, "reason": ...}`を返す仕様で、各ワークフローは`-o /dev/null`で本文を
捨てているため、ログの「報告しました」は「届いた」以上の意味を持たない。

#### 報告が一時的なAPI不調に当たると、`Implementation`のまま取り残される（#1861）

**「報告の失敗はジョブを落とさない」という取り決めは、失敗した報告を誰かが拾い直せることが
前提になっている。** その前提が成り立たない組み合わせが#1583で実際に起きた。

| 時刻(UTC) | 出来事 | 結果 |
| --- | --- | --- |
| 17:06 | `develop-pr-opened`が`POST /api/progress`（`status=develop-pr`）を実行 | **HTTP 500**。`::warning::`止まりでジョブは`success`、Statusは`Implementation`のまま |
| 17:13 | PR #1857 をdevelopへマージ、`develop-pr-merged`が起動 | ラベル一覧を引く`gh label list`が**HTTP 503**で落ち、`bash -e`でステップごと異常終了 |
| 〃 | 同ジョブの「Project Status を報告する」ステップ | 前のステップが落ちたため**実行されない**。`00.check-user`・`01.check-merge`も残留 |

拾い直す経路が無かった理由は2つある。**`develop-merge-sweep`は`Develop PR`にいるIssueしか
見ておらず、`develop-pr`への報告自体が失敗した今回はそこへ一度も到達していない。** そして
`develop-pr-merged`は、進捗の報告より先にラベル操作とコメント投稿を行う順序だった。

対処は3つ入れてある（`.github/workflows/reusable-issue-labels.yml`）。

- **`develop-merge-sweep`の対象に`Implementation`を加えた。** `Develop PR`へ到達しないまま
  マージされたIssueも15分ごとに拾える。ただし`Implementation`には「developへマージした後、
  追加対応でブランチへpushした」正規の状態（`mode=additional`）も含まれるため、
  **マージ済みPRの先端と現在のブランチの先端が一致するときだけ進める**（#1513と同じ考え方。
  マージでブランチが削除されている場合は追加のpushが無い証拠として扱う）
- **通知より先に対象Issue番号を`GITHUB_OUTPUT`へ書く。** ラベル操作・コメント投稿の失敗は
  すべて警告に留め、進捗の報告ステップまで必ず到達させる。ラベル一覧の取得にも再試行を入れた
- **`POST`/`GET /api/progress`に、5xxと接続失敗に限った再試行**（4回・10/20/30秒）。4xxは
  設定や実装の誤りで待っても変わらないため再試行しない

**再試行だけでは足りない。** #1583のAPI不調は7分続いており、この長さは`develop-merge-sweep`が
拾うことで吸収する。再試行は数十秒の揺らぎ、sweepはそれより長い障害、という役割分担になっている。

判定の失敗経路は実際に走らせないと確かめられないため、`scripts/reusable-issue-labels.test.mjs`が
YAMLから`run:`本文を取り出し、`gh`・`curl`をスタブに差し替えて`bash -e`で実行している。

#### PRマージとほぼ同時のpushは、どのPRにも載らないまま取り残される（#1999）

上の「マージ済みPRの先端とブランチの先端が一致するときだけ進める」というガードには、
**進めないと決めた後に何もしない**という穴があった。先端が一致しない理由は2つあり、
`develop-merge-sweep`はどちらも同じ1行をログへ書いて見送っていた。

- **追加対応で実装中**（`mode=additional`）。いずれPRが作られるので、見送るのが正しい
- **PRのマージとほぼ同時にpushされ、どのPRにも載らないコミット。** そのPRは既にcloseされて
  いるためdevelopへは入らず、新しいPRを誰も作らない。**放っておくと永久に取り残される**

`guchi-apps/subscription-lists#99`で起きたのは後者で、PR #97 のマージ（10:02:24）の2秒後に
ローカルセッションがコミットし、10:03:11に`issue-42`へpushした。各ワークフローの挙動は
設計どおりで、`wip-on-push`は「未マージの新規コミット」なので`implementation`を報告し、
`develop-merge-sweep`は先端不一致なので見送り続けた。**誰も間違っていないのに、developに
画面のルートが入らないまま本番が404を返し続け、人が手でブランチを調べるまで気付けなかった。**

そこで見送る前に「本当に取り残しか」を確かめ、取り残しなら人へ渡すようにした。

- **`compare/develop...issue-<番号>`でdevelopへ入っていないコミットの有無を見る。** 1件も
  無ければ先端が違っても取り残しは無いので、そのまま`Develop`へ進める（人がcherry-pick等で
  解消した後、ここで止まり続けないための経路でもある）
- **コミットが残っていても、`files`が空なら取り残しではない**（#2289）。compareは三点比較
  なので、`files`が空＝そのブランチをマージしてもdevelopへ何も入らない。**コミット数だけで
  判定すると、中身の無いマージコミットで`00.check-user`が付く。** 実際に起きたのは#2249で、
  コンフリクト解消のワークフロー（`claude-conflict-resolve`）とローカルセッションが同じ
  コンフリクトを別々に解消し、PRには片方だけが載ってマージされたため、`ahead_by=2`・
  変更ファイル0件のブランチが残った。`files`が読めない応答は従来どおり取り残しとして扱う
  （読み違えて見送ると、#1999で直したはずの「黙って取り残す」に戻るため）
- **未マージのコミットがある場合だけ、取り残しかを判定する。** develop向けPRが開いていれば
  実装中なので何もしない。開いておらず、最後のコミットから猶予時間（既定120分）が過ぎている
  ものだけを取り残しとして扱う。**回数ではなく時間で見るのは、巡回が実行と実行の間に
  状態を持てないため**（定期的に走るだけで、前回何をしたかを覚えていない）
- **通知は`00.check-user`＋`01.check-blocked`とIssueコメント。** ユーザーがやることは計画の
  承認ではなく続け方の指示（新しいPRを作る／ブランチを捨てる）なので理由は`01.check-blocked`
- **同じ先端について繰り返さない。** コメント末尾の`<!-- issue-deck-stranded:issue-<番号>@<SHA> -->`
  を既存コメントから探して冪等にする。新しいコミットがpushされればSHAが変わり、また通知される。
  既存コメントの取得に失敗したときは通知せず次回の巡回へ回す（二重投稿の方が重いため）

**検知できるのは`Develop PR`・`Implementation`にいるIssueだけ**（走査対象がそこに
限られるため）。取り残しを生むpushは`wip-on-push`が`implementation`を報告するので、実際に
起きた形はこの範囲に入る。`Develop`のまま取り残された場合は拾えないが、走査対象を広げると
リリース待ちの全Issueに対して巡回のたびにPRとcompareを引くことになるため広げていない。

**取り残しが解消されると自動で`Develop`へ進む。** 新しいPRを作ってマージすれば
`develop-pr-merged`が、cherry-pick等で解消した場合は上の「未マージのコミットが無ければ進める」が
拾い、どちらでも`00.check-user`は進捗の遷移とあわせて外れる。

### 取り残しの回収はissue-deck側の巡回が担う（#2294）

上の回収はもともと`reusable-issue-labels.yml`の`develop-merge-sweep`ジョブで、各リポジトリの
`issue-labels.yml`が持つ15分ごとのcronで動いていた。**判定の中身は変えずに、実行する場所だけを
issue-deck側の巡回（`POST /api/issues/progress-sweep`）へ移した。**

移した理由は課金。**Actionsの課金はジョブ単位で1分未満切り上げ**なので、実測20秒しか動かない
このジョブでも1回の実行で1分が課金される。同じcronで動く`manual-step-label`の埋め直しと
あわせて2分で、privateリポジトリ（`vps`・`subpc`・`docs`・`claude-config`）のActions従量課金の
ほとんどがこれになっていた（[github-billing.md](github-billing.md)）。

- **判定は[`lib/github/progress-sweep.ts`](../src/lib/github/progress-sweep.ts)、IOは
  [`lib/github/progress-sweep-run.ts`](../src/lib/github/progress-sweep-run.ts)。** コンフリクト
  巡回（#2116）・デプロイ失敗巡回（#2236）と同じ分け方で、サブPCのpollerが1巡ごとに叩く
- **速くなった。** GitHubのscheduleはcronに15分と書いてもそのとおりには走らず、実測は24〜36分
  間隔だった。巡回の間隔はissue-deck側の`PROGRESS_SWEEP_INTERVAL_MINUTES`（既定5分・0で無効）
  だけで決まる
- **対象の探し方が変わった。** `GET /api/progress`を経由せず、Projectのアイテム一覧を
  installationごとに1回引いて全リポジトリぶんを振り分ける（リポジトリ数だけ盤面を読み直さない）
- **pollerが止まっている間は巡回も止まる。** 既存の巡回2本と同じ前提で、GitHubのスケジューラ
  への依存がサブPCへの依存に変わっている
- **`schedule`で動くジョブはもう無い。** 他リポジトリのcallerに`cron`が残っていても、reusable側で
  受けるジョブが1つも無いので全ジョブがskipされ、課金は発生しない（skipジョブは課金対象外）

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
| Issueのクローズ | **issue-deck自身**（`issues` Webhook。#1856） | `closed` |

**ワークフローの`cleanup-on-close`は進捗を報告しない。** ここで`ready`を報告すると、
`Done`のIssueを人が閉じ直しただけで盤面が巻き戻る。closeを終端への遷移として扱うのは
issue-deck側で、次節のとおり遷移元を限定している。

### closeは終端`Closed`への遷移として扱う（#1856）

**`issue-<番号>`ブランチをheadとするPRが存在しない限り、`develop-pr`以降は誰も報告しない。**
上の表のとおり`develop-pr`・`develop`を報告するのは`reusable-issue-labels.yml`のPRオープン・
PRマージ・sweepだけで、どれも対象Issueをブランチ名から特定するためである。したがって
**PRを作らずに完了したIssueは`Implementation`に取り残され、自動では二度と進まない。**

PRを作らずに終わるのは例外ではなく、いずれも各リポジトリの実装プロンプトが正しい振る舞いとして
指示している経路である。

- 他ブランチ・他PRへ反映して完了した（コンフリクト解消など）
- 「すでに実装済み・対応不要」と判断して止まった（ファイルを変更せずPRも作らない）
- 成果が別リポジトリのPR、または`71.manual-step` Issueの起票だった
- 重複・見送りでcloseした

**closeは上のどの経路でも必ず起きる唯一確実な完了のシグナル**なので、これを終端への遷移として
扱う。実体は[`route.ts`](../src/app/api/webhooks/github/route.ts)の`closeStrandedProgress`。

#### 遷移先に`Done`を使わない

`Done`は「mainへマージ完了」で、リリース関連の表示と一括遷移がその意味に依存している。
特に「直近本番に反映した」ビューは、`filterLatestReleaseIssues`（[`issue-stats.ts`](../src/lib/issue-stats.ts)）が
**「そのリポジトリで最後にcloseされた`Done`のIssue」を基準に一定時間の窓を取る**作りのため、
リリースと無関係な手動closeが`Done`に混ざると基準を奪い、**本当のリリース分が一覧から消える。**
専用の終端`Closed`を足すことでこれを避けている。

#### 遷移元は`Planning`・`Implementation`・`Develop PR`に限る

定数は`CLOSE_TERMINAL_SOURCE_STATUSES`（[`issue-progress.ts`](../src/lib/issue-progress.ts)）。

- **`Develop`・`Release`は含めない。** developまで入って本番へ出ていない変更を抱えており、
  終端へ送ると「終わった」という嘘になる
- **`Ready`は含めない。** 未着手のまま終わっただけで、取り残されているわけではない
- **`Done`は含めない。** これにより「`Done`まで進んだIssueを人が閉じ直しても盤面が巻き戻らない」
  という現行の性質が構造的に保たれる

#### ワークフローではなくissue-deckのWebhookに置く

- 「Projectへの読み書きはissue-deckに一本化する」という中核の判断に沿う
- `cleanup-on-close`へ入れると、`workflows/vN`タグを配布先リポジトリすべてへ配り直すまで効かない。
  issue-deck側なら接続済みの全リポジトリへ同時に効く
- **`GITHUB_TOKEN`起点のcloseでもApp宛のWebhookは届く**（「他のワークフローを起動しない」という
  GitHubの仕様はActionsの中だけの話で、Webhookの配信には及ばない）。そのため`main-pr-merged`が
  `gh issue close`した場合もここへ来るが、そちらは`Develop`・`Release`からのcloseなので対象外に
  なり、`done`の報告と競合しない
- **ただし`main-direct-merged`（#1901）は競合しうるので、報告とcloseの順序が仕様になっている。**
  こちらが閉じるのは`Implementation`・`Develop PR`にいるIssueで、上の3つの遷移元にそのまま
  当てはまる。**`done`を報告してからcloseする**ことで、Webhook側は`onlyFrom`でProjectの実物を
  読み直して対象外（既に`Done`）と判断する。逆順にすると`Done`ではなく`Closed`へ落ちうる

#### 判定材料はProjectの実物

`reportProgressStatus`の`onlyFrom`が、Projectから読んだ現在のStatusと突き合わせてから書く。
Webhook側でDBの`projectStatus`も見ているが、あれは無関係なcloseでGraphQLを叩かないための
足切りにすぎない。**正しさは`onlyFrom`側が担保する**（報告の正しさをDBの鮮度に依存させない、
というこのAPI全体の方針と同じ）。

なお`onlyFrom`を指定した報告では、**盤面に載っていないIssueを載せない。** 載せると、closeされた
だけのIssueで盤面が埋まる（`addMissingProjectItems`がclosedなIssueを追加しないのと同じ理由）。

#### 既存の取り残しと取りこぼしの回収

`closeStrandedProjectItems`（[`sync-project-status.ts`](../src/lib/github/sync-project-status.ts)）が
画面の再同期から呼ばれ、closedなのに上の3状態に残っているIssueをまとめて`Closed`へ寄せる。
判定に必要な「Issueがclosedか」と「今のStatus」は`fetchProjectItems`のスナップショットに
両方入っているため、盤面を1回読むだけで済む。

#### `Closed`の選択肢を足すまでは何も起きない

Project側のStatusフィールドに`Closed`が無い間は、報告が`unknown_status`、再同期が`skipped`で
返って**何も書かない**（別のStatusで代用はしない）。壊れはしないが、効き始めるのは選択肢を
足してからになる。

#### `reopened`では何も戻さない

戻す先（`Implementation`だったのか`Ready`だったのか）を復元する材料が無く、推測で書くと人が
意図して置いた状態を壊す。必要なら画面右パネルの進捗セレクトから選ぶ（`PROGRESS_STATUSES`を
そのまま描画しているため、「対応終了」も手で選べる）。

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

### 通らなかった段はStatusに残らないので、コメントで見分ける（#2069）

Statusは**いまどこにいるか**しか持たず、**どの段を通ってきたか**は持たない。したがって
`Implementation`にいるIssueを見ても、`Planning`を通ってきたのか飛ばしてきたのかは分からない。
進捗ステッパー（[`workflow-status-steps.tsx`](../src/components/dashboard/workflow-status-steps.tsx)）は
現在位置より手前の段をすべて済み（チェック）で描いていたため、**計画を立てて承認まで通したIssueと、
`21.plan-required`を付けずに実装へ直行したIssueが画面上まったく同じ**に見えていた。

**ラベルでは判定できない。** `21.plan-required`は計画の承認時に外れる
（`labelsAfterApproval`。[`approval-labels.ts`](../src/lib/github/approval-labels.ts)）ので、
「承認済み」と「最初から計画を求めていない」がどちらもラベル無しになる。

そこで**Issueに残り続ける計画コメント**を根拠にする（[`planning-phase.ts`](../src/lib/github/planning-phase.ts)）。
無人実行の`<!-- issue-deck-plan-type:... -->`、ローカルセッションが手で投稿する
`<!-- issue-deck-agent:planner -->`、`ExitPlanMode`のフック経由の`<!-- issue-deck:session-plan -->`、
マーカー導入前の絵文字（🔍・🔀）のいずれかがあれば通ったと見なし、どれも無ければスキップとして
描く（破線の輪郭＋マイナス）。

- **判定できないときはスキップと言い切らない。** コメントの取得前は従来どおりの表示に留める。
  一瞬「計画スキップ」と出てから戻るのが最も紛らわしいため、`commentCount`と突き合わせて
  「取得前の空配列」と「コメントが1件も無いIssue」を区別する
- **Issue一覧の進捗バッジ（円グラフ）はコメントを持たないので判定しない。** もともとチェックを
  出しておらず段の割合を塗るだけなので、見分けが付かない問題自体が起きない
- **DBへ「Planningを通った日時」を持たせる案は採っていない。** スキーマ変更が要るうえ、
  すでに進んでいるIssueには値が入らない
- **`<!-- issue-deck:session-plan -->`は`session-plan.ts`からimportせず文字列で持つ。**
  あちらはGitHub Appのトークン解決とジョブの積み込み（Prisma）を抱えたサーバー専用モジュールで、
  `"use client"`のIssue詳細から辿ると同じバンドルへ入る（`session-wrapup.ts`も同じ理由で
  同じマーカーを文字列で持っている）。二重管理は**正とずれたら落ちるテスト**
  （[`planning-phase.test.ts`](../src/lib/github/planning-phase.test.ts)）で潰す——テストは
  サーバー側のモジュールを読んでよい

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
| `?repository=owner/name&status=develop,release` | `{ issues: [12, 34] }`（openのみ・昇順） | `main-pr-in-progress`・`main-pr-merged`・`release-develop-to-main.yml` |

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
| Claudeアプリ（`claude.ai/code`） | **人がその場で開始する** | 保持する | 常時（PC不要） | **報告のみ**（画面からの導線は#1769で削除） |

**ディスパッチできるのは上2つだけ。** 下2つは人が開いた時点で始まる引き取り型で、開いていない
セッションへジョブを送ることはできない。したがって必要なのは**進捗の報告だけ**である。

裏を返すと、**Phase 2の報告APIは4モードすべてに効く**。ディスパッチ（Phase 3・ミニPCのIssue）は
モードごとに別々でよいが、**報告は共通化する価値が最も高い**。ここが実行基盤に依存しない
インターフェースの核心にあたる。

### 下2つは既に運用されている

- **メインPC（VS Code）**: [`scripts/start-issue.sh`](../scripts/start-issue.sh)がworktreeを作り
  Claude Codeセッションを起動する。`11.local`ラベルを付けている間は`claude-issue-dispatch.yml`が
  そのIssueに対して何もしない（[multi-agent/branching.md](multi-agent/branching.md)）
- **Claudeアプリ**: かつてはIssueを指定して`claude.ai/code/new`を開くボタンを画面に置いていたが
  （#360・#499）、質問する・サブPCで実行するで用途が代替されたため**#1769で削除した**。
  人がClaudeアプリでIssueに取り組むこと自体は妨げられないが、issue-deckからの導線は無い

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

## 本番へ出たのにStatusが取り残されたときの直し方（#2140）

`Done`への一括遷移は`reusable-issue-labels.yml`の`main-pr-merged`ジョブが1回だけ行う。
**この1回を取りこぼしたIssueは`Release`のまま誰にも拾われない。** ジョブ自身のコメントにも
「取りこぼした場合はissue-deckの復旧後にこのrunを再実行する」とあるが、再実行では直らない
ケースがある。

- **対象はリリースPR本文の`## 対象issue`が先で、無いときだけProject Statusで探す。**
  本文の一覧はバージョンバンプの時点で凍結されるため、**その後にdevelopへ入ったIssueは
  一覧に載らないまま`develop`のマージでmainへ出る**（#2117以前、リリースPRのheadが`develop`
  だった頃の構造。v4.23.0のPR #2132 で#2117・#2121・#2123・#2126の4件が実際に取り残された）
- 再実行しても本文の一覧は変わらないので、**取り残しは手で直す**

直し方は次の3手順。**進捗を先に`done`にしてからcloseする**——順番を逆にすると、closeを
受けたissue-deckが終端`Closed`（対応終了）へ送る条件（`Planning`・`Implementation`・
`Develop PR`）に当たる可能性があり、本番反映済みのIssueが`Done`と別の終端に落ちる。

1. 取り残しを引く。`APP_BASE_URL`・`PROGRESS_REPORT_SECRET`は`.env.local`（サブPCは
   `~/.config/issue-deck/dispatch.env`）にあり、`scripts/lib/progress-report.sh`の
   `progress_resolve_endpoint`で解決できる

   ```bash
   source scripts/lib/progress-report.sh && progress_resolve_endpoint "$PWD"
   curl -sS -H "Authorization: Bearer $PROGRESS_SECRET" \
     "$PROGRESS_BASE_URL/api/progress?repository=guchi-apps/issue-deck&status=release"
   ```

2. mainに入っていることを実物で確かめる（`git log origin/main --oneline --merges`に
   `from guchi-apps/issue-<番号>`のマージコミットがあること、その先端の`deploy.yml`が
   成功していること）
3. `done`を報告してからcloseする

   ```bash
   curl -sS -X POST "$PROGRESS_BASE_URL/api/progress" \
     -H "Authorization: Bearer $PROGRESS_SECRET" -H "Content-Type: application/json" \
     -d '{"repository":"guchi-apps/issue-deck","issue":<番号>,"status":"done"}'
   gh issue close <番号> --reason completed
   ```

**GraphQLでProjectのフィールドを直接書き換えないこと。** Projectへの書き込みはissue-deckに
一本化してあり（上記「中核の判断」）、直接書くとDBのキャッシュと画面がずれる。

## 参考リンク

- GitHub Docs: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- GitHub Docs: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)（`projects_v2_item`）
- GitHub Docs: [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)（organization secretのプラン制約）
- 関連ドキュメント: [organization-migration.md](organization-migration.md)（Organization移行の判断材料）・[code-map.md](code-map.md)（データの流れ）
