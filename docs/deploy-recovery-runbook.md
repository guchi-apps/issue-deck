# 本番デプロイが止まったときの切り分けと次の一手（全アプリ共通）

いつ読むか: `deploy.yml`の本番デプロイが失敗し、`main`の版が本番で動いていないとき。どのアプリでも、まずここで失敗の種類を決め、種類ごとの次の一手を取る（#5632）。

対象は`app-deploy-gate`（guchi-apps/vps `scripts/app-deploy-gate.sh`）経由でVPSへ配るアプリ。**gate経由のデプロイではVPSのシェルを取れず、本番DBにも直接つながない。** 本番の状態を変える手段は「コードを`main`へ出し、そのデプロイで実行させる」しかない。

## 1. 入口

| 状況 | 使うもの |
|---|---|
| 一時的な失敗（ネットワーク・GitHub側の障害） | `deploy-retry`が1回だけ自動で再実行する（[auto-repair.md](multi-agent/auto-repair.md)「本番デプロイの一時的な失敗の再実行」）。再実行で直れば何もしない |
| 再実行でも直らない | ブランチ画面のデプロイ失敗の帯「リリース完了まで進める」（旧「AIに修正を依頼」。復旧の系列。#3998）。原因の区分の報告→修正PR→developへマージ→（許可していれば）main向け復旧PR→再デプロイ→稼働版の確認まで同じ系列で進む |
| 修正がすでにdevelopにある | 帯の「既存の修正PRを選んで復旧」。選んだPRの差分だけをmain起点の復旧PRに取り込む（[release.md](multi-agent/release.md)「本番デプロイ復旧PRは『マージ差分だけ』を適用する」） |

復旧の系列は、修正Issueの本文に**ログからの判別**（下の種類のどれか。機械判定の手掛かり）を書く。判別の正は`src/lib/deploy-failure-kind.ts`。

## 2. 種類の切り分け

`deploy`ジョブのログ（Actionsの失敗した実行）を上から順に照らし、最初に当たったものを種類とする。

| 種類 | ログの手掛かり | 区分（修正Issueで報告するマーカー） |
|---|---|---|
| A. 失敗記録が残っている | `Error: P3009`（`migrate found failed migrations`） | `migration` / `migration_unsafe` |
| B. マイグレーションのSQLエラー | `Error: P3018`（`A migration failed to apply`）、`Database error code: …` | `migration` / `migration_unsafe` |
| C. マイグレーション前の補修の失敗 | `app-deploy-gate: deploy/pre-migrate.sh が失敗しました` | 補修スクリプトの不具合なら`code`、安全弁で止まったなら`migration_unsafe` |
| D. gateでの失敗 | `app-deploy-gate: <理由>`（展開・依存・再起動・ヘルスチェック・稼働版の不一致） | 理由による（下記） |
| E. ビルドの失敗 | `Failed to compile`・`Type error:`・`ELIFECYCLE` など（gateに届く前） | `code` |

## 3. 種類ごとの次の一手

### A. P3009（失敗したマイグレーションの記録が残っている）

本番DBの`_prisma_migrations`に「失敗」が残り、`prisma migrate deploy`が以降のマイグレーションを適用しない。**SQLを直しただけのリリースでは直らない**（記録が残る限り毎回P3009で止まる）。asset-manager v9.0.0（asset-manager#1630〜#1635）がこの形で、修正PRだけを含む復旧PRでは直らず、人が別PRで出し直した。

1. 最初に失敗した実行（P3018が出た実行。P3009より前）のログで、マイグレーション名と`Please check the query number N`を読む
2. **部分適用の判定**（下記）を行う
3. 自動で解消してよい（区分`migration`）なら、**同じ修正PR**に次の2つを入れる
   - マイグレーションの修正（本番の権限・既存データで通る形へ。適用済みの文があっても通るように書く）
   - `deploy/pre-migrate.sh`: gateが`prisma migrate deploy`の直前にマイグレーション用の接続先で実行する。失敗の記録を`prisma migrate resolve --rolled-back <名前>`で外し、直したマイグレーションを適用し直させる。**名前の決め打ちにせず**、未解決の失敗を読んで対象を決め、条件に合わないときは何もせず失敗で止める安全弁を持たせる（例: issue-deck自身の`deploy/pre-migrate.sh`と`docs/pr-auto-repair-migration-recovery.md`、asset-manager#1636）
4. 復旧の系列は、区分`migration`のとき**復旧PRを作る前に**「修正PRが`deploy/pre-migrate.sh`を含む、またはmainに既にある」を確かめる。どちらも無ければ`migration_resolver_missing`で止まる。そのときは解消手段を入れたPRをdevelopへマージし、「既存の修正PRを選んで復旧」で修正PRと一緒に選ぶ
5. 復旧PRがmainへ入ると、そのデプロイで記録の解消→再適用→再起動→稼働版の確認まで進む。系列が`recovered`になれば完了

**部分適用の判定材料**: MySQL/MariaDBのDDLは文ごとに自動コミットされ、マイグレーションが途中で失敗しても前の文は残る。

- 失敗した文が1番目（`query number 1`）、または前の文がスキーマ・データを変えない → 解消してよい
- 前に変更する文があっても、修正版がその状態で通る（`IF NOT EXISTS`・存在確認つき・冪等）→ 解消してよい
- それ以外・判断できない → `migration_unsafe`。**コミットもPRも作らない。** 自動で記録を外して再適用すると、残った変更とぶつかるか二重に適用される。修正Issueへ、確かめるべき本番の状態（表・列・インデックス）と最小の操作を書いて人へ渡す。人は本番DBの状態を確かめ、残った変更を前提にした修正版か、残った変更を戻す補修を`deploy/pre-migrate.sh`へ書いて出す

### B. P3018（マイグレーションのSQLが本番で失敗した）

この実行で失敗の記録が残るため、次のデプロイからはAになる。**最初からAとして扱う**（SQLの修正と`deploy/pre-migrate.sh`を同じPRに入れる）。よくある原因:

- 権限不足（`1044`・`1142`）: 本番のマイグレーション用ユーザーに無い権限（`CREATE TEMPORARY TABLES`など）を使っている。権限を足すのは本番設定の変更なので人へ渡す。多くはSQLを権限の要らない形へ書き換える方が早い
- MySQLとMariaDBの差・既存データとの衝突: ローカル・CIでは通る。本番と同じ条件の検証が無いアプリは、再発防止をアプリ側のIssueにする（asset-manager#1637）

### C. `deploy/pre-migrate.sh`の失敗

補修スクリプト自体の不具合なら`code`で直す。安全弁（想定外の履歴・既存の表）で止まったなら、本番の状態が想定と違う。`migration_unsafe`として人へ渡す。

### D. gateでの失敗

`app-deploy-gate: `に続く理由で分ける。

- `別のデプロイが実行中です`: 先行のデプロイが終わってから再デプロイ（ブランチ画面の「本番へ再デプロイ」）
- `ecosystem.config.js がありません`・`PORT が決まりません`・`lockfile が無いため…`: 配布物の構成の不足。`code`
- `ヘルスチェックに失敗しました`・`稼働中の版が対象コミットと一致しません`: 起動に失敗している。アプリの起動時エラー（環境変数の不足は`config`、コードの不具合は`code`）。PM2のログはgateからは読めないため、ログが要るときは人へ渡す
- `<パス> がありません（provision-app で…）`・公開先の不備: VPS側の準備不足。`config`として、guchi-apps/vpsのIssueへ切り出す
- `deploy/gate-install.sh が失敗しました`（Python等、Prismaを使わないアプリ）: マイグレーションの失敗記録の扱いはアプリのツールごとに違う。Aの考え方（記録の解消もコードで出す・部分適用なら止める）だけを当てはめ、手段は`gate-install.sh`の中に書く

### E. ビルドの失敗

gateに届く前に止まっているので本番は前の版のまま。`code`として直す。ローカル・CIで通るのに本番ビルドだけ落ちるときは、本番用の環境変数・依存の差を疑う。

## 4. 系列の外で復旧したとき

人が別のPRで`develop`→`main`を出して直した場合、止まっていた系列とリリース候補の表示は自動では閉じない（#5633で扱う）。新しい版が本番で動いていることを確かめ、系列は画面から停止する。
