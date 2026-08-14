# issue-deck 固有ルール

このリポジトリで作業するClaude Codeエージェント向けのルールを記載する。

ローカル実行ではユーザー個人環境のグローバルルール（`~/.claude/CLAUDE.md`）と個人環境のスキルもあわせて読み込まれるが、GitHub Actions上での実行（`.github/workflows/claude-issue-dispatch.yml`など）はリポジトリをチェックアウトしたワークツリーしか参照できないため、それらは読み込まれない。したがってActions実行でも守られる必要があるルールは、このファイルか各ワークフローのプロンプトに明文化しておく必要がある。両方が読み込まれる環境で内容が矛盾する場合は、このファイルを優先する。

コードの構成（ディレクトリ規約・データの流れ・`src/proxy.ts`など、どこに何があるか）は [docs/code-map.md](docs/code-map.md) を参照する。

## 共通ルール（ローカル実行・GitHub Actions実行の両方に適用）

コミットメッセージ・PRタイトル・PR本文・issueコメントを日本語で書くこと、コミットのAuthorを`Claude Code <claude-code@example.com>`にすること、ラベルの付け替え手順といった作業手順レベルの規約は、各ワークフローのプロンプト（`.github/workflows/claude-issue-dispatch.yml`・`.github/workflows/claude-review-develop.yml`）とローカルセッション用のプロンプト（`scripts/prompts/`）に記載している。ここには、それらに含まれていない横断的な判断基準のみを記載する。

### 出力言語

エージェントの出力は日本語で書く。対象は成果物（コミットメッセージ・PR・Issueコメント）だけでなく、**応答本文・作業の要約・TODO・提示する計画・ツール実行時の説明といった画面に出る文章も含む**。コード・識別子・ファイルパス・コマンド・設定値・ログやエラーメッセージの引用は原文（英語）のままでよい。

指示文の正は`scripts/lib/agent-language.sh`にあり、ローカルセッションは起動時に`--append-system-prompt`で受け取る（`scripts/run-issue-session.sh`・`scripts/start-reviewer.sh`）。無人実行はそこを通らないため、同じ文面を各プロンプトの「## 出力言語」にも置いている（`.github/prompts/`・`scripts/prompts/`）。**文面を変えるときは両方を揃える**（#1395、[docs/multi-agent/prompts-and-models.md](docs/multi-agent/prompts-and-models.md)）。

### 依存関係の追加

新しい依存関係（パッケージ・ライブラリ・ツール）を追加する前には、必ずユーザーに確認を取る。`package.json`への追記や`pnpm add`等の実行は、確認が取れてから行う。

GitHub Actions上の無人実行では、その場で確認を取る相手がいない。依存関係の追加が必要だと判断した場合は追加せずに作業を止め、`00.check-user`ラベルを付与したうえで、なぜ必要かをIssueコメントで相談する。

### シークレットの扱い

- APIキー・トークン・パスワード等の実シークレットをリポジトリにコミットしない。コミットしてよいのは、値を空にしたサンプル（`.env.example`・`.env.local.example`）と、1Passwordの`op://vault/item/field`形式の参照だけを書いたテンプレート（`.github/*.env.tpl`・`.github/secrets-manifest.tsv`）に限る。実値は`.gitignore`済みの`.env*`と1Password側にのみ置く。
- **1Passwordは「人が管理する唯一の正」だが、GitHub Actionsの実行時の取得先ではない**（#1302）。1Passwordサービスアカウントには日次レート制限（1Passwordアカウント全体で1,000リクエスト/日。サービスアカウントを分けても分割されない）があり、実行のたびに読むとフリート全体のデプロイが止まる。`ci.yml`・`deploy.yml`・`release.yml`はGitHubのsecret/variableから取得する。対応表は`.github/secrets-manifest.tsv`、同期は`scripts/sync-github-secrets.sh`（値を変更したときだけ実行する）。
- **このリポジトリはPUBLICでActionsのログが誰でも読める。** GitHubのvariableはマスクされないため、公開されても害が無いと確認できた値だけをvariableにする。ホスト名・ポート・ユーザー名・DB名のような接続先の構成情報は、単体では資格情報でなくともsecretに置く。
- 実シークレットの値を、コミットメッセージ・PR本文・Issueコメント・ワークフローのログなど、リポジトリやGitHub上に残る場所へ出力しない。
- 既存のシークレット・環境変数の設定変更が必要になった場合は、自動で進めず`00.check-user`を付与してユーザーの確認を待つ（後述の「自動マージ不可カテゴリ」にも該当する）。

## 全アプリ共通の共有知識（shared context）

複数アプリで再利用できる知識は、このリポジトリではなく共有知識リポジトリ（`m-guchi/docs`）で管理する。設計の全体像は [docs/shared-knowledge.md](docs/shared-knowledge.md) を参照。

### 参照先

- **GitHub Actions実行**: 各ワークフローが実行前に`.shared-context/`へcheckoutする。存在しない場合（checkout失敗時など）は共有知識なしでそのまま作業を進めてよい。
- **ローカル実行**: `~/apps/_docs`（`scripts/start-issue.sh`・`scripts/start-reviewer.sh`が`--add-dir`で参照可能にする）。

読む順序は、`CLAUDE.md`（索引）→ 自分の役割の`agent-rules/`（実装エージェントなら`agent-rules/implementation.md`、レビュー・統合エージェントなら`agent-rules/review.md`）→ 必要に応じて`knowledge/`の該当ファイル → 設計判断が要るときだけ`standards/`の該当ファイル → 手作業の設定手順が要るときだけ`guides/`。最初から全部を読む必要はない。各ファイルの冒頭に「いつ読むか」の1行があるので、それで読むかどうかを判断する。

### 参照の優先順位

内容が矛盾する場合は、具体的で近いものを優先する。

1. Issue本文・コメントでの明示的な指示
2. このファイル（`CLAUDE.md`）
3. このリポジトリの`docs/`
4. `.shared-context/CLAUDE.md`・`.shared-context/agent-rules/`
5. `.shared-context/knowledge/`・`.shared-context/standards/`・`.shared-context/guides/`

共有知識は「他のアプリではこうしている」という既定値であり、issue-deck固有のルールを上書きしない。

### 書き込みの禁止と提案フロー

- `.shared-context/`配下は**読み取り専用**として扱う。編集・`git add`・コミットは一切行わない（`.gitignore`済み）。
- 実装中に得た知見は、次の基準で置き場所を分ける。**迷った場合はアプリ固有として扱う。**
  - **アプリ固有**（このリポジトリのコード・スキーマ・画面・ラベル・ワークフローに依存する）→ 実装PRに同梱して`docs/`または`CLAUDE.md`へ書く。
  - **全アプリ共通**（対象リポジトリを差し替えても内容が成立し、数週間以上有効で、根拠を示せる）→ 共有知識リポジトリへ直接書かず、対応Issueへ「追加提案」コメントを投稿するにとどめる。
- ローカルセッションのメモリ（`~/.claude/projects/<slug>/memory/`）は機体ローカルで、メインPC・サブPC間で同期されず、GitHub Actionsの無人実行には存在しない。恒久的に価値がある内容は上の基準で昇格させる（判断基準は [docs/multi-agent/personal-config-sync.md](docs/multi-agent/personal-config-sync.md)「メモリを同期せず『昇格』させる」）。
- 提案コメントの書式・審査の4観点（再利用性・正確性・重複・恒久性）・反映までの流れは [docs/shared-knowledge.md](docs/shared-knowledge.md) の「9. 共有知識更新フロー」を参照。承認された提案のみ、`.github/workflows/shared-knowledge-propose.yml`が共有知識リポジトリへのPull Requestに変換し、最終的なマージは人間が行う。
- シークレットの実値・個人情報・一時的な障害情報は、アプリ固有・共通のいずれにも記録しない。

## Issueごとの複数Claude Codeエージェント運用

Issueごとに専用ブランチ・git worktree・Claude Codeセッションを分離して実装する運用を導入している（詳細設計は [docs/multi-agent-workflow.md](docs/multi-agent-workflow.md) を参照）。

### ブランチ運用

- `main`は本番環境と一致するリリース用ブランチで、直接コミット・pushしない。`develop`が日常の開発ブランチで、本番へ反映する変更は`develop`→`main`のPull RequestをCI通過後にマージする。
- Issue単位の作業ブランチは`develop`から作成し、ブランチ名は`issue-<Issue番号>`とする（例: `issue-123`）。
- worktreeは本体リポジトリの外（`~/apps/issue-deck-worktrees/<ブランチ名>/`）に作成する。

### 実装エージェント（Issueごとに起動するセッション）の禁止事項

- `main`/`develop`への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- **担当Issue以外の実装。** 作業中に別件を新規Issueとして起票するのはよいが、そのIssueをこのセッション・このブランチで実装しない。進捗の遷移・closeはブランチ名`issue-<番号>`だけを見ており、無人実行の停止フラグ（`11.local`）と画面のセッション表示は起動時に渡されたIssue番号だけに付くため、別Issueを混ぜると起票したIssueは`Ready`のまま取り残され、同時に無人実行の二重起動を止めるものが無くなる。実施するなら別セッションを起こす（[docs/multi-agent/branching.md](docs/multi-agent/branching.md)「セッション中に作った新しいIssueは、そのセッションで実施しない」）
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

### レビュー・統合エージェントの禁止事項

- `main`への直接マージ・push

### 監視・計画レビューを行う実行体の禁止事項

セッションの状態を見る仕組みや、計画をレビューする仕組みを足すときに守る（設計の全体像は
[docs/multi-agent/gates.md](docs/multi-agent/gates.md) を参照。**監督のための役は新設しない**）。

- **実行体が判断して組み立てた文字列・確定キーのtmuxセッションへの送出（`send-keys`）。** 選択フォームの表示中に本文＋Enterを送り、1問目が既定の選択肢で勝手に回答済みになった事故があるため、状況を読んで返事を組み立てる実行体を作らない。**例外は「人が押した1回の操作」の2つ**で、どちらも本文を決めるのは人。
  - **画面の「停止」（#1332）**: 固定の`C-c`だけを送る（答えを選ばせも埋めもしないため同じ事故は起こせない）
  - **画面の「追加指示を送る」（#1012）**: 人が書いた1行を3段階プロトコル（状態確認→本文のみ送出→入力欄への反映を再確認→確定キーを別送）で送る。承認プロンプト・選択フォームの表示中は送らず、反映を確認できなければ**Enterを送らずに終える**。CI失敗などを見て自動で送る経路は作らない
- **計画の承認。** 計画のレビューは根拠付きの指摘と承認可否の推奨までとし、承認コメントの投稿は人が行う
- **権限の恒久的な拡大**（承認プロンプトの「今後聞かない」を選ばせない）
- **見覚えのないプロンプト・想定外の画面への応答。** 必ず人へ引き上げる
- **developへのマージ操作。** developへの自動マージ自体は許可するが、マージ操作を持つのはレビュー・統合エージェント（と`claude-review-develop.yml`）だけにする。2か所に置くと自動マージ不可カテゴリと`22.merge-confirm-required`の判定を両方で守り続ける必要が生まれ、片方が緩んだ時点でそこが単独の穴になる

### 実装前の計画フェーズ（`21.plan-required`ラベル）

- Issueに`21.plan-required`ラベルが付いている場合、実装前にPlan modeで計画（アプローチ・変更範囲・懸念点）を提示し、承認を得てから実装に入る。
- 進捗（Project Status）は計画の検討に着手した時点（Plan mode開始時点）で`Planning`になり、承認後・実装着手時点で`Implementation`へ進む。
- ラベルが付いていない場合は直接実装してよく、`Planning`は経由せず最初から`Implementation`になる。
- 承認待ちの合図には`00.check-user`ラベルを使う。

### Issueの進捗の状態遷移

**進捗はGitHub ProjectsのStatusで管理する。唯一の正はStatusで、進捗ラベルは存在しない**（#991 Phase 5・#1010で`01.planning`〜`09.main`を廃止した。設計は[docs/progress-status-architecture.md](docs/progress-status-architecture.md)）。マルチエージェント運用で進めるIssueは、原則として以下の順でStatusが遷移する。

1. `Ready` — 未着手
2. `Planning` — 実装エージェントが計画検討中（`21.plan-required`選択時のみ経由）
3. `Implementation` — 実装エージェントがコード実装中
4. `Develop PR` — developへPR作成・マージ中
5. `Develop` — developへマージ完了（main未反映）
6. `Release` — mainへPR作成・マージ中
7. `Done` — mainへマージ完了。**この時点でissueをclose**する

Statusを進めるのはissue-deckだけで、各ワークフロー・ローカルセッションは進捗報告API（`POST /api/progress`）へ報告する。**`gh issue edit`で進捗を付け替えることはできない。** 人が動かす場合はカンバンのカードをドラッグするか、issue-deckの画面のボタン、またはIssue詳細の右パネル（プロパティ）の「進捗」セレクトを使う。**右パネルのセレクトは状態を書き換えるだけで実行を起動しない**（起動を伴うのはカンバンのドラッグと「実装を開始」ボタン）。

`00.check-user`（ユーザーのチェックが必要）は上記のどの段階でも他のラベルと併用して付与する。

`11.local`（ローカルで対応中）も同様にどの段階でも併用でき、付いている間は`claude-issue-dispatch.yml`（無人実行）がそのIssueに対して計画・実装・分割・追加対応を一切行わない（読み取り専用の質問応答のみ例外）。VSCode等のローカルClaude Codeセッションで対応するIssueに付けることで、ローカルと無人実行がラベル操作をきっかけに二重起動するのを防ぐ（詳細は[docs/multi-agent/branching.md](docs/multi-agent/branching.md)「ローカル実行と無人実行の二重起動を防ぐ」参照）。優先度ラベルは`11.local`と番号帯が重ならないよう`80.Priority: High`・`89.Priority: low`へリネームした。

`Release`・`Done`に対応するdevelop→mainのリリースフロー自体は、バージョンbump PR・develop→mainのPR作成までを`.github/workflows/release-develop-to-main.yml`が自動化している（詳細は[docs/multi-agent/release.md](docs/multi-agent/release.md)参照）。develop→mainの実際のマージは下記「自動マージ不可カテゴリ」に該当するため人間が手動で行う。

### ユーザーの手作業が残る場合は新規Issueとして起票する（`71.manual-step`ラベル）

実装の結果として、エージェントが代行できないユーザー自身の操作（本番サーバー上の`.env`の書き換え、GitHub Appの権限追加、1Passwordでのトークン発行、外部サービスの管理画面での設定など）が残る場合、**PR本文の「注意点」やIssueコメントに書くだけで終わらせず、その手作業を単独の新規Issueとして起票する。** 書くだけではPRがマージされ元のIssueが`Done`でcloseされた時点で追跡できなくなる。

- ラベル: `71.manual-step`（`00.check-user`とは併用しない）
- タイトル: `[手作業] <実行する場所>: <やること>`
- 本文: 「やること（コピペで実行できるコマンド）」「実行する場所」「なぜエージェントが実施しないか」「放置するとどうなるか」「完了の確認方法」「関連（起点Issue・PR）」
- 起点IssueへGitHubネイティブのサブIssueとして紐付け、起点IssueとPRにリンクをコメントする
- issue-deckのサイドメニューの「手作業待ち」ビュー（`view=manual-step`）に集まる。**エージェントへ送り直すIssueではないため実装開始の導線は出ず**、実行したユーザーがIssue詳細の「手作業を完了してクローズ」でcloseする（進捗Statusは`Ready`のままでよい）

判断基準・本文テンプレートの全文・設計理由は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「デプロイ後などに残るユーザーの手作業はIssueとして起票する」を参照。

### 自動マージ不可カテゴリ（`00.check-user`付与対象）

以下に該当する変更は、レビュー・統合エージェントが自動マージせず`00.check-user`を付与し、ユーザーの確認を待つ。

- 認証・認可
- DBスキーマ変更・マイグレーション
- 本番環境の設定
- GitHub Actionsやデプロイ設定
- Secretsや環境変数
- 課金・決済
- 大規模な依存関係の更新
- `develop`→`main`のマージ

上記カテゴリに該当するかどうかによらず、Issueに`22.merge-confirm-required`ラベルが付いている場合も、develop向けPRへのpushのたびに常に`00.check-user`が付与され自動マージがスキップされる（詳細は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「developへのマージ前確認要否をIssueラベルでトグルする」参照）。

### PR本文テンプレート

`develop`宛のPRには以下を記載する。

- 対応Issue（`closes #番号`/`fixes #番号`は使わず`#番号`のみ記載する。developマージ時点ではissueをcloseしない運用のため）
- 実装内容
- テスト内容
- 確認方法
- 注意点
