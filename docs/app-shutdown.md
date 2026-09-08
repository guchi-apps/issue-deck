# アプリ終了とリポジトリアーカイブの手順

**個人アプリの運用をやめ、GitHubリポジトリをアーカイブするときに読む。** 立ち上げ側
（[new-app-launch.md](new-app-launch.md)と共有知識の`guides/new-app-checklist.md`）の逆順にあたる。

正本が無かったため、これまでの2件は毎回ゼロから調べ直していた。

| 事例 | 起点 | issue-deck側の対応 | 残っている記録 |
|---|---|---|---|
| `guchi-apps/shopping-list`（2026-08-28。Dayspanへ機能を集約） | guchi-apps/shopping-list#188 | #2435 | [supported-repositories.md](supported-repositories.md)の該当行 |
| `guchi-apps/trainroute`（2026-09-07。依存元がすべて未配線と判明） | guchi-apps/trainroute#40 | #2882 | 同上と、trainroute側の`docs/decommission.md` |

本書は**どのアプリにも共通する順序・落とし穴・issue-deck側の消し込み**を持つ。アプリ固有の事情
（実機のプロセス名・DB名・依存元）は、対象リポジトリの`docs/decommission.md`に書く。同じ手順を
2か所に持たない。

**前提とする構成はPM2 ＋ Apache VirtualHost ＋ MariaDB**（フリートの標準）。静的配信
（`solitaire`）・user systemd（`signaly`）・VPS外（`wifi-speed`）はプロセスの止め方だけが違うので、
その差分は対象アプリの`docs/decommission.md`へ書く。

## 削除ではなくアーカイブする

**`gh repo delete`は使わない。** 他リポジトリのIssueコメント・ドキュメント・PR本文から対象への
リンクが多数張られており、消すとそれらが全て404になる。判断の記録（なぜ作り、なぜやめたか。
外部APIの契約条件や技術選定の経緯）も、次に似たアプリを作るときの出発点として残る価値がある。

アーカイブすればIssue・PR・Actionsは読み取り専用になり、**無人実行の対象としては自動的に外れる**
（後述「アーカイブで自動的に外れるもの」）。

## 終了してよいかを確かめる

「画面を使っていない」だけでは足りない。**サーバー間参照用のAPIを他アプリが叩いていないか**を
実測する。trainrouteでは、配線済みに見えたDaySpanからの呼び出しが**呼び先の未実装で一度も
成立していなかった**ことが分かり、削除の影響がゼロだと確定できた。

- 他アプリのコードから対象アプリのホスト名・トークン名で横断検索する
  （調べ方は[multi-repo-changes.md](multi-repo-changes.md)の横断質問）
- 各アプリの`.github/secrets-manifest.tsv`と`.env.example`に対象アプリ向けの変数が無いかを見る
- 見つかった依存は「配線されているか」ではなく「**実際にデータを取れているか**」まで確かめる

調査結果は対象アプリの`docs/decommission.md`へ表で残す。後から「なぜ消してよいと判断したか」を
説明できるのはこれだけになる。

## 撤去の順序

**守る必要がある依存は2つだけ。** 残りは並行して進めてよい。

1. **他アプリの後片付け → 1Passwordのアイテム削除。** 利用側の`.github/secrets-manifest.tsv`が
   `op://apps/<終了アプリ>/...`を参照したままアイテムを消すと、そのアプリで次に
   `scripts/sync-github-secrets.sh`を流したときに値を引けなくなる。
   `scripts/check-duplicate-secret-values.sh`も「参照先が実在しないフィールド」として落ちる
   （**アーカイブ済みリポジトリのマニフェストは読まないが、他アプリのマニフェストは読む**）
2. **外形監視の解除 → サイトの停止。** 順序を逆にすると、その間ダウン通知が鳴り続ける

**壊れる引き金は「1Passwordのアイテムを消すこと」であって、アプリを止めることではない。** 実行時の
シークレットの取得先はGitHubのsecretで、1Passwordは「値が変わったときだけ同期する正」という運用
（[CLAUDE.md](../CLAUDE.md)「シークレットの扱い」）。したがって実機の撤去とアーカイブは、他アプリの
後片付けを待たずに進めてよい。

推奨する並び:

1. 依存元アプリの後片付け（コード・`secrets-manifest.tsv`・`.env.example`。アプリごとにIssueを分ける）
2. 外形監視からモニターを外す（Uptime KumaはRender上の画面で操作する。ops-dashboardは読むだけ）
3. 「VPSからの撤去」＋「本番デプロイを止める」（**同じタイミングで行う**）
4. 「シークレットの後片付け」（1Password・GitHub Secrets）
5. 「台帳の更新」（issue-deck・`guchi-apps/vps`・`guchi-apps/docs`）
6. 「リポジトリのアーカイブ」（**最後**）

## VPSからの撤去は3本立てで行う

Apacheのvhostは`guchi-apps/vps`の管理下にあり、証明書とサイトの無効化には`sudo`が要る。
**「リポジトリから消す」「実機で無効化する」「Git管理外の実機資源を消す」は経路が別**で、
どれか1つでは止まらない。`<TARGET_DIR>`はGitHub Secretの`TARGET_DIR`（VPS上のデプロイ先。既定は
`/home/github-user/apps/<アプリ名>`）に読み替える。

### (a) `guchi-apps/vps`から設定ファイルを消す（Issueを切り出す）

**実機の設定ファイルを直接書き換える手順を手作業Issueに書かない**（[CLAUDE.md](../CLAUDE.md)
「VPS・サブPCの設定ファイルの変更は、管理リポジトリのIssueへ切り出す」）。対象は
`apache/sites-available/<host>.gucchii.com{,-le-ssl}.conf`。`guchi-apps/vps`へIssueを立てて切り出し、
起点Issueのサブissueとして紐付ける。実機へ出るまでのマージは2回（Issueブランチ→`develop`、
`develop`→`main`のリリースPR）。

**ただし、消しても実機からは消えない。** `scripts/apply.sh`は`apache/sites-available/*.conf`を
**リポジトリから実機へコピーするだけ**で、リポジトリから消したファイルの`a2dissite`・削除を行う
経路を持たない。逆に実機だけ消してリポジトリに残すと、次のデプロイで復活する。**両方消す。**

### (b) 実機での無効化（`sudo`が要るのでユーザーが実行する）

VPSの手順はサブPCからTailscale SSHで代行実行できるが、**`sudo`を含む手順は代行できない**
（NOPASSWDの設定が無く必ず失敗する。#2901）。ここは`71.manual-step`のIssueにし、手順の文頭に
`（VPS）`・`（ブラウザ）`を書く。

```bash
# 1) Apacheのサイトを無効化して設定を消す
sudo a2dissite <host>.gucchii.com <host>.gucchii.com-le-ssl
sudo rm -f /etc/apache2/sites-available/<host>.gucchii.com.conf \
           /etc/apache2/sites-available/<host>.gucchii.com-le-ssl.conf
sudo apache2ctl configtest && sudo systemctl reload apache2

# 2) Let's Encryptの証明書を削除する
sudo certbot delete --cert-name <host>.gucchii.com
```

そのうえで**VPSの管理画面からAレコードを削除する**（APIが無いためブラウザでの手作業）。
**DNSを先に消すと`certbot delete`より前に更新が失敗しうる**ため、順序はこのままにする。証明書を
残したままドメインを畳むと、更新のたびにcertbotが失敗して通知が鳴り続ける。

### (c) Git管理外の実機資源を消す（`sudo`が要らない）

`pm2`とデプロイ先ディレクトリの削除は`sudo`が要らないので代行実行できる。**DBの操作だけは
`-p`でパスワードを対話で聞かれるため代行できない**ので、手作業Issueでは「あなたが実行」に分ける。

```bash
# 1) PM2から外す（dump.pm2からも消すため pm2 save まで行う）
pm2 delete <アプリ名>
pm2 save

# 2) DBのダンプを控えてから落とす
mysqldump -u root -p app_<アプリ名> > ~/app_<アプリ名>-$(date +%Y%m%d).sql
mysql -u root -p -e "DROP DATABASE app_<アプリ名>;"

# 3) デプロイ先ディレクトリを消す（.envに実シークレットが入っている）
rm -rf "<TARGET_DIR>"
```

## 本番デプロイを止める

**実機の撤去と同じタイミングで行う。** 順序を空けた分だけデプロイが失敗する。実機のディレクトリを
消した後に`main`が動くと`Upload archive`の`scp`が
`dest open "<TARGET_DIR>/deploy.tar.gz": No such file or directory`で落ち、issue-deckが
「デプロイ失敗」Issueを自動で起票する。**撤去が原因なので再実行しても直らない。**

`.github/workflows/deploy.yml`の`on:`から**起動できるトリガーを全部外す**（`workflow_call`だけを
残す）。**ファイルごと消さない。**

- **`push: main`を外すだけでは止まらない。** issue-deckは「mainへマージしたのに`deploy.yml`の実行が
  1件も作られない」状態をGitHubのイベント配送漏れとみなし、`workflow_dispatch`で起動し直す
  （[`deploy-launch-sweep-run.ts`](../src/lib/github/deploy-launch-sweep-run.ts)）
- **`workflow_dispatch`を持たないワークフローへの起動は422になり、issue-deckは「起動できない
  リポジトリ」として通知も再試行もせずに畳む**（同ファイルの`unsupported`。`:300-303`）。
  ファイルごと消すと422ではなくなるため、この静かな経路から外れてしまう
- **`deploy-retry.yml`は個別に止めなくてよい。** 起動条件が`deploy.yml`の完了（`workflow_run`）
  なので、起動元が走らなくなれば自動で止まる
- **止めた後は`main`へマージしてもタグとGitHub Releaseは作られない**（`deploy.yml`の`tag`・
  `release`ジョブが作っているため）
- **デプロイ失敗Issueは自動でcloseされない。** issue-deckが閉じる契機は「次のデプロイの成功」で、
  デプロイをしなくなる以上その契機が来ない。**手でcloseするのはアーカイブした後**。
  [`deploy-failure-sweep-run.ts`](../src/lib/github/deploy-failure-sweep-run.ts)は追跡中のIssueが
  無くなると立て直すため、先にcloseすると同じIssueがもう1件立つ

## シークレットの後片付け

依存元アプリの参照を外した**後で**行う。

- 1Passwordの`apps`ボールトのアイテムは**削除ではなくアーカイブへ移す**
  （`op item delete "<アイテム名>" --vault apps --archive`。共有知識`inventory/README.md`）
- 立ち上げが投入するのは`target-dir`・`db-name`・`allowed-google-emails`・`ci-webhook-url`の4つ
  （[`scripts/provision-app-secrets.sh`](../scripts/provision-app-secrets.sh)）。アプリ独自に足した
  フィールドは`.github/secrets-manifest.tsv`で確認する
- **他アプリのアイテムに、終了するアプリ向けのフィールドが混じっていることがある**
  （trainrouteでは`op://apps/aide/trainroute-token`が、参照されないまま登録だけされていた）
- **GitHub Secretsはリポジトリをアーカイブしても消えない。** 明示的に削除する

  ```bash
  for k in DB_NAME TARGET_DIR ALLOWED_EMAIL ...; do
    gh secret delete "$k" --repo guchi-apps/<repo>
  done
  gh variable delete AUTH_URL --repo guchi-apps/<repo>
  ```

- **Supabase側に消すものは無い。** プロジェクトは他アプリと共有で、Redirect URLsは本番サブドメインを
  ワイルドカードで登録している（共有知識`knowledge/supabase.md`）
- **外部APIの契約を解約するかはユーザーが決める。** 費用が発生しないなら残す判断もありうるが
  （trainrouteの駅すぱあとはこれ）、**契約ドメインがそのアプリのホスト名で残るため、そのキーを
  他アプリへ流用することはできない**

## 台帳の更新

台帳は3つのリポジトリに分かれている。**issue-deck側だけを直して終わりにしない**——直近の
trainrouteの撤去では、`guchi-apps/vps`と共有知識側の消し込みが残作業になった。

**リポジトリごとにIssueを分ける**（[CLAUDE.md](../CLAUDE.md)「複数リポジトリに影響する変更は、
リポジトリごとにIssueを分ける」）。他リポジトリのファイルをこのセッションで直さない。
**`guchi-apps/vps`・`guchi-apps/docs`へは無人実行から起票も検索もできないことがある**
（GitHub Appのインストール範囲。調査中: #2908）。起票できなければユーザーへ渡す。

### `guchi-apps/vps`側

- `apache/sites-available/<host>.gucchii.com{,-le-ssl}.conf`（上の「(a)」で切り出したIssueで消す）
- READMEの「アプリ一覧」の行
- READMEの「予約済みポート（未デプロイ）」節の末尾にある空きポートの記述（空いた番号を戻す）

### `guchi-apps/docs`（共有知識）側

**共有知識は直接編集しない。** `guchi-apps/docs`へIssueを立てて切り出す。

- `standards/tech-stack.md`のスタック一覧の行
- `inventory/1password-apps.md`の行
- `knowledge/`に残っている言及（アプリ名で横断検索して拾う）

### issue-deck側で触るファイル

- [`docs/supported-repositories.md`](supported-repositories.md) — **行は消さずステータスを`運用終了`に
  する**（#2435）。消すと「もともと載っていなかった」のか「終了して外した」のかが区別できない。
  あわせて次の3か所を直す
  - ローカル起動プロトコルの適合状況の表
  - `sync-state`マーカー（コピー方式のワークフローのドリフト記録）を**削除**する。残すと
    `scripts/check-workflow-sync-drift.sh`が解消できない差分を出し続ける
  - 配布対象を数える`for r in ...`のコマンド例に`--no-archived`が付いているかを確かめる
    （`gh repo list`は既定でアーカイブ済みも返すため、付けないと終了したリポジトリを数え続ける）
- [`scripts/local-repo-ports.conf`](../scripts/local-repo-ports.conf) — **既定は行を消さずコメント化
  して帯を予約する**（判断基準は[local-quick-start.md](multi-agent/local-quick-start.md)「運用を
  終了したリポジトリの帯は、行を消さずコメント化して予約する」）。サブPCにチェックアウトも
  worktreeも残っていないと確かめられた場合だけ、行ごと削除して帯を空きに戻してよい
  （trainrouteはこちら）。**削除する場合は3か所を揃える**（#2877）
  - `src/lib/new-app/local-port-bands.test.ts`の残り枠の期待値（**実物のconfを読むので落ちる**）
  - [`docs/multi-agent/local-quick-start.md`](multi-agent/local-quick-start.md)の「現在の帯は
    4000〜NNNNN。残っているのはN枠」の散文
- [`.github/duplicate-secret-allowlist.txt`](../.github/duplicate-secret-allowlist.txt) —
  `op://apps/<終了アプリ>/...`の行を消す（残しても検査は落ちないが、実在しないパスが溜まる）
- [`scripts/local-repo-pr-policy.conf`](../scripts/local-repo-pr-policy.conf) と
  `src/lib/prompts/pr-policy.ts`の`MANUAL_PR_REPOSITORIES` — 載っている場合だけ。
  **両方直す**（`src/lib/prompts/templates.test.ts`がずれを検出する）
- `~/.config/issue-deck/local-repos.conf`（サブPC上・リポジトリ外） — チェックアウトを残すなら
  そのままでよい。アーカイブ後はIssueが読み取り専用になり、起動する対象が無くなる

## リポジトリのアーカイブ

**最後に行う。** アーカイブするとIssue・PR・Actionsがすべて読み取り専用になり、撤去作業の消し込みが
できなくなる。

```bash
gh repo archive guchi-apps/<repo>
```

アーカイブしたら、issue-deckの画面（設定＞フリート運用）の**「リポジトリを再同期」**を押す。
GitHubの`archived`は再同期のタイミングでDBへ取り込まれるため
（[`repository-sync.ts`](../src/lib/github/repository-sync.ts)）、押すまでは盤面に残る。

## アーカイブで自動的に外れるもの・外れないもの

**外れる。** `Repository.archived`を`false`で絞っている経路はすべて対象外になる。手で除外リストを
持つ必要は無い。

- 画面（設定＞フリート運用）の共有ワークフロー配布・参照タグ更新（`lib/github/workflow-tags.ts`）
- 各巡回（進捗・コンフリクト・デプロイ失敗・Projectsの同期・添付画像の掃除）
- シークレット同期・PR一覧・ブランチフローの各API
- `scripts/check-duplicate-secret-values.sh`の参照元収集（`gh repo list --no-archived`）

**外れない。**

- `repositoryFullName`を文字列で持つ表（`DispatchJob`・`DispatchSession`・`NightlyRunEntry`・
  `ManualStepRun`・`DeployFailureIssue`など）のレコードは残る。実害は無いので消さない
- ドキュメントに書いた`gh repo list`のコマンド例（`--no-archived`を付ける）
- GitHub Secrets・1Passwordのアイテム・VPS実機の資源・DNS・外形監視

## 完了の確認

```bash
# 本番デプロイに起動できるトリガーが無いこと（`workflow_call`の1行だけが出れば完了）
sed -n '/^on:/,/^$/p' .github/workflows/deploy.yml

# 公開が止まっていること
curl -sS -o /dev/null -w '%{http_code}\n' -m 10 https://<host>.gucchii.com/ || echo "到達不可（期待どおり）"

# DNSが引けないこと（何も出なければ完了）
dig +short <host>.gucchii.com A

# PM2に残っていないこと（VPS上で実行）
pm2 describe <アプリ名> >/dev/null 2>&1 && echo "まだ残っている" || echo "ok"

# DBが残っていないこと（VPS上で実行）
mysql -u root -p -e "SHOW DATABASES LIKE 'app_<アプリ名>';" | grep -q app_ && echo "まだ残っている" || echo "ok"

# 参照先が実在しないシークレットが無いこと（サブPCのissue-deckで実行）
scripts/check-duplicate-secret-values.sh

# ドリフト検査に終了リポジトリが出てこないこと
scripts/check-workflow-sync-drift.sh
```

## アプリ側`docs/decommission.md`の雛形

対象リポジトリの`develop`へ、アーカイブ前に置く。**アーカイブ後も読める**ので、途中で中断しても
どこまで進んだかを判定できる。

```markdown
# <アプリ名> の撤去手順

**このアプリは廃止する。** 本書は停止・撤去の順序と実機コマンドの正本。起点は #<番号>。
共通の順序と落とし穴は guchi-apps/issue-deck の docs/app-shutdown.md を参照する。

## なぜ削除してよいと判断したか（<日付>時点の調査）
| 依存元 | 実態 | 削除の影響 |
|---|---|---|

## このアプリ固有の事情
（プロセス名・DB名・外部APIの契約・他アプリとの共有資源など、共通手順と違う点だけ）

## 完了の確認
（docs/app-shutdown.md の確認コマンドを、このアプリの値で埋めたもの）
```

## 関連

- [new-app-launch.md](new-app-launch.md) — 立ち上げ（本書の逆順）
- [supported-repositories.md](supported-repositories.md) — 対応リポジトリの台帳と`運用終了`の扱い
- [multi-repo-changes.md](multi-repo-changes.md) — 他リポジトリへIssueを切り出すときの進め方
- [multi-agent/labels.md](multi-agent/labels.md) — `71.manual-step`の書式、実機設定の切り出し
