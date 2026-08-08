# プレビュー環境（Fly.io Machines）

`23.preview-required`ラベルが付いたIssueで、実装内容を本番相当のデータ・GitHub連携込みで
実際に開いて確認できるオンデマンドのプレビュー環境。以下のサブIssue群にまたがって構築した。

- #826: 全体設計（本ドキュメントの元になった検討）
- #829: 書き込み系API routeを403で封じる`PREVIEW_MODE`ガード
- #830: Fly.io Machine構成（`fly.toml`・`Dockerfile`・起動スクリプト）
- #831: 本番DBダンプ・サニタイズ・`fly deploy`を行うデプロイworkflow
- #832: 無人実装フロー（`claude-issue-dispatch.yml`）への接続、本ドキュメントの新規追加

## 全体像

```
claude-issue-dispatch.yml（実装ブランチ issue-<番号> へのPR作成まで完了）
  └─ deploy-preview ジョブ (workflow_call)
       └─ deploy-preview.yml
            1. 実装ブランチをcheckout
            2. 本番DBをssh経由でmysqldump
            3. サニタイズ用MariaDB（ジョブ限りの使い捨てコンテナ）へロード
            4. installation ID書き換え・ユーザートークンNULL化（開発App向け）
            5. サニタイズ済みDBを db-dump/dump.sql.gz として再ダンプ
            6. db-dump/dump.sql.gz を焼き込んで docker build → fly deploy
       └─ outputs.preview_url を返す
  └─ notify-preview-url ジョブ
       └─ 実際に開けるプレビューURLをIssueへ別コメントで通知
```

Fly Machine自体は「Next.js standalone + MariaDB」を1プロセスずつ同居させた単一コンテナで動く
（`scripts/preview-entrypoint.sh`がMariaDBを起動・ダンプロードしてからNext.jsを起動する）。
本番DBを別途Fly.io上に用意するのではなく、デプロイのたびにイメージへダンプを焼き込む方式にした
理由は、本番DBへプレビュー環境から直接接続する経路を作らないため（#826の設計判断）。

## 構成要素

| ファイル | 役割 | 追加Issue |
|---|---|---|
| `fly.toml` | Fly.io Machine構成（`app`名・リソースサイズ・`auto_start_machines`/`auto_stop_machines`等） | #830 |
| `Dockerfile` | deps→builder→runnerの3ステージビルド。runnerに`mariadb-server`を同梱 | #830 |
| `scripts/preview-entrypoint.sh` | コンテナ起動時にMariaDB初期化→ダンプロード→Next.js起動の順序を制御 | #830 |
| `src/lib/preview-mode.ts` | `PREVIEW_MODE=true`時に書き込み系API routeを403で封じるガード | #829 |
| `.github/workflows/deploy-preview.yml` | 本番DBダンプ・サニタイズ・`fly deploy`を行う、`workflow_call`可能なworkflow | #831 |
| `.github/deploy-preview.env.tpl` | `deploy-preview.yml`が読み込む1Password参照テンプレート | #831 |
| `scripts/preview-sanitize-dump.mjs` | installation ID書き換え・`User`の GitHub トークンNULL化 | #831 |
| `.dockerignore`の`!db-dump/dump.sql.gz` | 焼き込み用ダンプをビルドコンテキストから除外しないための例外 | #831 |
| `.github/workflows/claude-issue-dispatch.yml`の`deploy-preview`・`notify-preview-url`ジョブ | 無人実装フローからの呼び出し・結果通知 | #832 |

## GitHub Appを開発App（issue-deck-dev）に分ける理由

本番DBのコピーをそのまま使うため`GithubInstallation.installationId`は本番Appのインストール
IDが入っているが、これをそのまま使うと開発Appとして認証した際に404になる
（`src/lib/github/app-auth.ts`のInstallation Token取得はApp単位で紐づくため）。そのため
`scripts/preview-sanitize-dump.mjs`が、開発App（`issue-deck-dev`, App ID `4445268`）の
インストールID解決APIを叩いて`GithubInstallation.installationId`を書き換える。本番の
`GithubInstallation`・開発App側のインストール一覧がいずれも1件でない場合は、一意制約違反を
避けるため書き換えを行わずエラー終了する設計になっている（複数件になった場合は要再検討）。

併せて、コピーした本番DBに残っている`User.githubAccessToken`・`User.githubRefreshToken`は
プレビュー環境では無効な値（本番App向けに発行されたもの）のためNULL化する。

## 安全対策

- `PREVIEW_MODE=true`（`fly.toml`の`[env]`で固定）により、書き込み系API routeは403を返す
  （`src/lib/preview-mode.ts`）。プレビュー環境から誤って本番のGitHubリポジトリへ書き込みが
  発生しないようにするための多重防御。
- 本番DBの認証情報はmysqldumpのコマンドライン引数（`-u`/`-p`）で渡さず、
  `--defaults-extra-file=/dev/stdin`でssh経由の標準入力から読ませる。本番サーバーは共用機の
  ため、コマンドライン引数だと他ユーザーから`ps`で認証情報が見えてしまう。
- `GITHUB_USER_TOKEN_ENCRYPTION_KEY`（ログイン時にGitHubユーザートークンを暗号化して保存する
  ための鍵）は、本番の鍵を複製せず`deploy-preview.yml`が`openssl rand -base64 32`でデプロイの
  たびに生成する。Machineは起動のたびにダンプからDBを作り直し、ダンプ中の
  `User.githubAccessToken`・`githubRefreshToken`は`preview-sanitize-dump.mjs`でNULL化済みの
  ため、鍵が毎デプロイ変わっても復号できない暗号文が残ることはない。未設定だと
  `/auth/callback`が500になる（#880）。
- プレビュー環境は`ALLOWED_EMAILS`によるログイン必須（未ログインでは中身を見られない）。
  当初は多重防御として`fly.toml`の`auto_start_machines = false`も併用し、URLを外部から
  叩かれただけではMachineが起動しないようにしていたが、`auto_stop_machines`によりアイドルで
  停止した後は再デプロイするまで誰も開けない（503）状態になり、レビュー用URLとして成立
  しなかったため`auto_start_machines = true`に変更した（#880）。停止・起動のコスト面の
  制御は`auto_stop_machines = "stop"`（アイドル時に自動停止）が引き続き担う。
- `.github/workflows/deploy-preview.yml`は`concurrency: group: deploy-issue-deck-preview`
  （`cancel-in-progress: true`）を持つ。プレビュー環境はFly.io Machine 1台の使い捨て共有
  リソースのため、複数Issueから同時に呼ばれても直列化され、先行実行は後続に置き換わる
  （同時に2つのプレビューを別々のURLで提供する構成にはしていない）。

## 無人実装フローとの接続（#832）

`claude-issue-dispatch.yml`のtriageジョブは、Issueに`23.preview-required`ラベルが付いているかを
`preview_required`という出力に反映する（`24.screenshot-required`の`screenshot_required`と同じ
仕組み）。dispatchジョブ（実装・PR作成を行うClaude Codeステップを含む）が完了すると、以下の2
ジョブが続けて動く。

- **`deploy-preview`**: `preview_required=true`かつmode（陳腐化チェック後の値。dispatchジョブの
  `outputs.final_mode`）が`implement`/`additional`のときだけ、`deploy-preview.yml`を
  `workflow_call`で呼び出す。`ref`には実装ブランチ（`issue-<番号>`）を渡す。developではなく
  実装ブランチそのものをデプロイするのは、develop向けPRのレビュー中に実際の変更内容を画面で
  確認できるようにするため。
- **`notify-preview-url`**: `deploy-preview`の結果（成功時は`outputs.preview_url`、失敗時は
  実行ログURL）をIssueへ別コメントとして通知する。

実装完了報告コメント（dispatchジョブ内のClaude Codeステップが投稿するもの）は、
`deploy-preview`ジョブの完了を待たずに投稿される。本番DBダンプ・サニタイズ・`fly deploy`を
含めて数分かかるデプロイを、実装ステップの中で同期的に待つことができないため。そのため
実際に開けるプレビューURLは、実装完了報告コメントとは別の、後続のコメントとして届く
（`<!-- issue-deck-agent:implementer -->`マーカー付き）。

developへの実際のマージは、これまでどおり`claude-review-develop.yml`の`risk-check`ジョブが
`23.preview-required`を検知して`00.check-user`を付与するため、人間がプレビュー環境で画面を
確認するまで保留される（「developへのマージ前確認要否をIssueラベルでトグルする」参照）。

### `deploy-preview.yml`自体の変更が反映されるタイミング

`claude-issue-dispatch.yml`は`uses: ./.github/workflows/deploy-preview.yml`とローカル参照で
呼び出している。GitHub Actionsの仕様上、この形の再利用ワークフローの定義は**呼び出し側runの
ref**から読まれる。`claude-issue-dispatch.yml`は`issue_comment`等で起動するためrunのrefは常に
デフォルトブランチ（`develop`）であり、実装ブランチ側で`deploy-preview.yml`を直しても、
developへマージされるまでそのrunには一切反映されない（#880で、Machine起動ステップを実装
ブランチに追加したのにデプロイ後もMachineがstoppedのままだった原因）。

一方、`fly.toml`・`Dockerfile`・`scripts/preview-entrypoint.sh`はworkflowが
`actions/checkout`で`inputs.ref`（実装ブランチ）をチェックアウトしたものを使うため、
実装ブランチの内容がそのまま反映される。

実装ブランチ側の`deploy-preview.yml`の変更を試したい場合は、`deploy-preview.yml`を
`workflow_dispatch`でそのブランチを指定して直接実行する（`workflow_dispatch`は指定したref上の
workflow定義で動く）。

## 未整備・要確認事項

`.github/deploy-preview.env.tpl`のコメントに記載のとおり、以下は本ドキュメント作成時点
（#832）で未確認・未整備。実際に`deploy-preview.yml`を初めて動かす前に、人間の確認・準備が
必要。

- 1Password（vault: `apps`）に以下2項目の追加が必要（未作成）
  - `apps/issue-deck/fly-api-token`
  - `apps/issue-deck/preview-github-app-private-key-base64`（開発App`issue-deck-dev`の
    秘密鍵、base64）
- `issue-deck-dev`（開発App）のインストール範囲が本番Appと同じリポジトリ群かどうか
- `fly.toml`の`app = "issue-deck-preview"`が実際に`fly apps create`済みの名前かどうか
  （プレースホルダーのままの可能性あり）
- 本番`GithubInstallation`テーブルの行数が実際に1件のみか（複数件の場合、
  `scripts/preview-sanitize-dump.mjs`はエラー終了する設計のため要再検討）
- プレビューのログイン許可メールアドレス（`ALLOWED_EMAILS`）を本番の値のまま流用してよいか
