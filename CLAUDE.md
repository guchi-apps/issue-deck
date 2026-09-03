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

GitHub Actions上の無人実行では、その場で確認を取る相手がいない。依存関係の追加が必要だと判断した場合は追加せずに作業を止め、`00.check-user`ラベル（と理由を表す`01.check-blocked`）を付与したうえで、なぜ必要かをIssueコメントで相談する。

### シークレットの扱い

- APIキー・トークン・パスワード等の実シークレットをリポジトリにコミットしない。コミットしてよいのは、値を空にしたサンプル（`.env.example`・`.env.local.example`）と、1Passwordの`op://vault/item/field`形式の参照だけを書いたテンプレート（`.github/*.env.tpl`・`.github/secrets-manifest.tsv`）に限る。実値は`.gitignore`済みの`.env*`と1Password側にのみ置く。
- **1Passwordは「人が管理する唯一の正」だが、GitHub Actionsの実行時の取得先ではない**（#1302）。1Passwordサービスアカウントには日次レート制限（1Passwordアカウント全体で1,000リクエスト/日。サービスアカウントを分けても分割されない）があり、実行のたびに読むとフリート全体のデプロイが止まる。`ci.yml`・`deploy.yml`・`release.yml`はGitHubのsecret/variableから取得する。対応表は`.github/secrets-manifest.tsv`、同期は`scripts/sync-github-secrets.sh`（値を変更したときだけ実行する）。
- **アプリ間で共有する認証値は、値を複製せず提供側の`op://`を1か所だけ参照する**（#2624）。利用側のマニフェストの`SOURCE`列を、値を検証する側（提供側）のアイテムにする。2アプリの間だけで使う値はorganization secretへ寄せず、repository secretのまま参照先だけを揃える。複製と参照先の不在は`scripts/check-duplicate-secret-values.sh`で検出できる（判断基準は[docs/cross-repo-setup-guide.md](docs/cross-repo-setup-guide.md)「アプリ間で共有する認証値は提供側の`op://`を参照する」）。
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

### 書き込みの禁止と知見の残し方

- `.shared-context/`配下は**読み取り専用**として扱う。編集・`git add`・コミットは一切行わない（`.gitignore`済み）。
- 実装中に得た知見は、次の2つを**両方**行って残す。**共有知識へ格上げすべきかどうかは判定しない**（#2029）。
  - 実装PRに同梱して`docs/`または`CLAUDE.md`へ書く
  - 同じ内容を「知見メモ」コメント（`<!-- knowledge-candidate -->`）としてIssueへ投稿する
- 格上げの判定と共有知識への反映は、共有知識リポジトリ（`guchi-apps/docs`）側の格上げ判定エージェントが、フリート全リポジトリの知見メモをまとめて審査して行う。判定を待つ必要は無く、実装はそのまま進めてよい。
- ローカルセッションのメモリ（`~/.claude/projects/<slug>/memory/`）は機体ローカルで、メインPC・サブPC間で同期されず、GitHub Actionsの無人実行には存在しない。恒久的に価値がある内容は上の2つへ昇格させる（判断基準は [docs/multi-agent/personal-config-sync.md](docs/multi-agent/personal-config-sync.md)「メモリを同期せず『昇格』させる」）。
- 知見メモの書式・判定エージェントの動き・反映までの流れは [docs/shared-knowledge.md](docs/shared-knowledge.md) の「9. 共有知識更新フロー」を参照。
- シークレットの実値・個人情報・一時的な障害情報は、`docs/`にも知見メモにも記録しない。

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

### 複数リポジトリに影響する変更は、リポジトリごとにIssueを分ける

**Issueを起点に他リポジトリへIssueやPRが自動作成される仕組みは無い**（#1698）。自動でPRが配られるのは共有ワークフローの参照タグ（`@workflows/vN`・`prompts-ref`）だけで、それも画面のボタンから起動する別経路であり、内容の変更は運ばない。

横展開が必要だと分かったら、**このセッションで他リポジトリを触らず**、対象リポジトリごとにIssueを立てて親IssueへサブIssueとして紐付ける。上の禁止事項「担当Issue以外の実装」がそのまま当てはまる。影響範囲の調べ方（横断質問）・変更の種類ごとの配り方・追跡の残し方は[docs/multi-repo-changes.md](docs/multi-repo-changes.md)を参照する。

### 他リポジトリへ起票する前に、同じ対象のopenなIssueを探す

**`gh issue create --repo <owner>/<repo>`を打つ前に、対象リポジトリのopenなIssueを引く**（#2250）。
`aide-bot`の立ち上げでは、同じ「vhostを作って公開する」作業のIssueが`guchi-apps/vps`へ4件立った。
ラベルもタイトルの形もばらばらで、後から調査に入ったエージェントが既存のIssueを探さないまま
起票し直したのが原因。

```bash
gh issue list --repo guchi-apps/vps --state open --search "aide-bot" --json number,title
```

- 探す語は**対象の固有名**（アプリ名・ホスト名・サービス名）にする。「vhost」「証明書」のような
  作業名では別の対象まで釣れる
- 立ち上げが作ったIssueには本文の先頭に`<!-- new-app-launch: … -->`の印がある。
  **GitHubのIssue検索はHTMLコメントの中身も索引している**ので`--search "new-app-launch <アプリ名>"`で引ける
- **見つかったら起票せず、そのIssueへコメントする。** 手順が足りなければそのIssueへ書き足す。
  **同じ手順を2か所に持たない**（`#2216`と`guchi-apps/vps#124`でcertbotの手順が重複し、片方が宙に浮いた）
- 判断基準の詳細は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「他リポジトリへ起票するときも、先に探す」を参照

### すでに実装済み・対応不要のIssueは実装せず、報告して止まる

起票から時間が経ったIssueは、**別のIssue・PRで先に対応されていたり、前提の変更で問題自体が消えていることがある**（#1601）。その場合は無理にファイルを変更せず、根拠を添えて報告し、続け方の指示を待つ。既に満たされている要求へ重ねて実装すると、既存の実装と競合し、レビューの手間だけが増える。

- **推測で決めない。** `develop`の最新コードを実際に読み、要求が満たされていることを確かめる。根拠として**該当ファイルのパスと行番号**、および対応したPull Request・コミット・Issue番号のいずれかを示せること
- **満たされているのが要求の一部だけなら、残りは実装する。** 全体として満たされている場合だけ止まる
- **「◯◯の手作業を省く」種類のIssueは、要求ではなく目的が満たされていないかを確かめる**（#1002）。要求（Organizationのデフォルトラベルの登録）が未実施でも、目的（新規リポジトリへのラベル初期投入）が起票後に入った別経路で満たされていれば、実装しても効果はゼロになる。**その手作業が今も発生しているのか**をコードで確認してから着手し、消えていれば根拠を添えて報告して続け方の指示を待つ
- **コミット・push・PR作成をしない。** 空コミットも、辻褄合わせの変更も入れない。**Issueもcloseしない**（closeするか別の要件として作り直すかはユーザーが決める）
- 止まり方は実行経路で違う。無人実行は`gh issue comment`で報告したうえで`00.check-user`＋`01.check-blocked`を付けて停止する（`.github/prompts/implement.md`・`plan.md`）。ローカル実行は端末でユーザーへ確認しつつ、同じ内容をIssueコメントにも残す（`scripts/prompts/implementation-agent.md`・`generic-implementation-agent.md`）
- 理由ラベルが`01.check-plan`でなく`01.check-blocked`なのは、ユーザーがやることが「計画の承認」ではなく「続け方の指示」だから（[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「理由を表す`01.check-*`ラベル」）

### レビュー・統合エージェントの禁止事項

- `main`への直接マージ・push

### 監視・計画レビューを行う実行体の禁止事項

セッションの状態を見る仕組みや、計画をレビューする仕組みを足すときに守る（設計の全体像は
[docs/multi-agent/gates.md](docs/multi-agent/gates.md) を参照。**監督のための役は新設しない**）。

- **実行体が判断して組み立てた文字列・確定キーのtmuxセッションへの送出（`send-keys`）。** 選択フォームの表示中に本文＋Enterを送り、1問目が既定の選択肢で勝手に回答済みになった事故があるため、状況を読んで返事を組み立てる実行体を作らない。**例外は3つで、いずれも本文を実行体が決めない。** 最初の2つは「人が押した1回の操作」で、本文を決めるのは人。
  - **画面の「停止」（#1332）**: 固定の`C-c`だけを送る（答えを選ばせも埋めもしないため同じ事故は起こせない）
  - **画面の「追加指示を送る」（#1012）**: 人が書いた1行を3段階プロトコル（状態確認→本文のみ送出→入力欄への反映を再確認→確定キーを別送）で送る。承認プロンプト・選択フォームの表示中は送らず、反映を確認できなければ**Enterを送らずに終える**。CI失敗などを見て自動で送る経路は作らない
  - **APIエラーで中断したセッションの自動再開（#1971）**: 人の操作を挟まない唯一の経路。Claude CodeがAPIの一時エラー（529等）を再試行しきるとturnが打ち切られ、**`Stop`フックが飛ばないまま**止まる（通知も出ず、回収も「追加指示を送る」も効かない）。送るのは`scripts/lib/session-resume.sh`が持つ**固定の1行だけ**で、状況を読んで本文を変えない。送ってよいのは**転記の末尾がAPIエラーで、一定時間更新が止まっている**と確かめられたセッションに限り、送り方は「追加指示を送る」と同じ3段階プロトコル。上限回数（既定3回）を使い切ったら送るのをやめ、issue-deckへ引き上げて人へ渡す（Issueコメント＋`00.check-user`＋`01.check-blocked`が付き、Push通知が鳴る）
- **計画の承認。** 計画のレビューは根拠付きの指摘と承認可否の推奨までとし、承認コメントの投稿は人が行う
- **権限の恒久的な拡大**（承認プロンプトの「今後聞かない」を選ばせない）
- **見覚えのないプロンプト・想定外の画面への応答。** 必ず人へ引き上げる
- **developへのマージ操作。** developへの自動マージ自体は許可するが、マージ操作を持つのはレビュー・統合エージェント（と`claude-review-develop.yml`）だけにする。2か所に置くと自動マージ不可カテゴリと`22.merge-confirm-required`の判定を両方で守り続ける必要が生まれ、片方が緩んだ時点でそこが単独の穴になる

### 実装前の計画フェーズ（`21.plan-required`ラベル）

- Issueに`21.plan-required`ラベルが付いている場合、実装前にPlan modeで計画（アプローチ・変更範囲・懸念点）を提示し、承認を得てから実装に入る。
- 進捗（Project Status）は計画の検討に着手した時点（Plan mode開始時点）で`Planning`になり、承認後・実装着手時点で`Implementation`へ進む。
- ラベルが付いていない場合は直接実装してよく、`Planning`は経由せず最初から`Implementation`になる。
- 承認待ちの合図には`00.check-user`ラベルを使う。
- **ローカルセッションが出した計画は、issue-deckのIssue詳細から承認・修正できる**（#2061）。
  Plan modeで計画を出すと画面に「計画の承認を待っています」パネルが出て、「承認して実装へ
  進む」「修正を送る」を押せる（押した内容はIssueコメントにも残る）。**`send-keys`は使わず**、
  計画を投稿したフックがClaude Code自身の許可判定として返すため、
  [docs/multi-agent/gates.md](docs/multi-agent/gates.md)の禁止には触れない。既定30分で待ちが
  切れ、その後は従来どおり端末・Remote Controlから答える。**押すのは1回で、端末・Remote
  Controlでの承認し直しは要らない**（#2121。承認を返すときに`updatedInput`を添えないと
  Claude Codeが聞き直すため、二重承認になっていた。
  [docs/multi-agent/session-notify.md](docs/multi-agent/session-notify.md)「承認・修正は画面から送れる」）

### Issueの進捗の状態遷移

**進捗はGitHub ProjectsのStatusで管理する。唯一の正はStatusで、進捗ラベルは存在しない**（#991 Phase 5・#1010で`01.planning`〜`09.main`を廃止した。設計は[docs/progress-status-architecture.md](docs/progress-status-architecture.md)）。マルチエージェント運用で進めるIssueは、原則として以下の順でStatusが遷移する。

1. `Ready` — 未着手
2. `Planning` — 実装エージェントが計画検討中（`21.plan-required`選択時のみ経由）
3. `Implementation` — 実装エージェントがコード実装中
4. `Develop PR` — developへPR作成・マージ中
5. `Develop` — developへマージ完了（main未反映）
6. `Release` — mainへPR作成・マージ中
7. `Done` — mainへマージ完了。**この時点でissueをclose**する

これとは別に、**本流から外れた終端`Closed`（対応終了）がある**（#1856）。他ブランチ・他PRへ反映して完了した、「すでに実装済み・対応不要」と判断して止まった、成果が別リポジトリのPRや`71.manual-step` Issueの起票だった、重複・見送りでcloseした——といった**PRを作らずに終わったIssue**は、`issue-<番号>`ブランチをheadとするPRが無いため`Develop PR`以降を誰も報告せず、`Implementation`に取り残される。そこでissue-deckがIssueのcloseを受け取った時点で、Statusが`Planning`・`Implementation`・`Develop PR`のときに限り`Closed`へ送る。`Done`（本番反映済）とは別の状態にしてあるので、リリース関連の一覧に混ざることはない（設計は[docs/progress-status-architecture.md](docs/progress-status-architecture.md)「closeは終端`Closed`への遷移として扱う」）。

Statusを進めるのはissue-deckだけで、各ワークフロー・ローカルセッションは進捗報告API（`POST /api/progress`）へ報告する。**`gh issue edit`で進捗を付け替えることはできない。** 人が動かす場合はカンバンのカードをドラッグするか、issue-deckの画面のボタン、またはIssue詳細の右パネル（プロパティ）の「進捗」セレクトを使う。**右パネルのセレクトは状態を書き換えるだけで実行を起動しない**（起動を伴うのはカンバンのドラッグと「実装を開始」ボタン）。

`00.check-user`（ユーザーのチェックが必要）は上記のどの段階でも他のラベルと併用して付与する。**誰がいつ付け、いつ外すのかの一覧は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「`00.check-user`が付く・外れるタイミング」を参照**（無人実行・ローカル実行・画面操作の3経路に分かれているため、ここを正とする）。**付けるときは、その理由を表す`01.check-*`ラベル（`01.check-plan`・`01.check-input`・`01.check-merge`・`01.check-blocked`・`01.check-answered`）も1枚あわせて付ける**（#1490。同じ節を参照）。理由ラベルは`00.check-user`とのANDでしか読まれず、**そのリポジトリに定義が無ければ付けなくてよい**。

`11.local`（ローカルで対応中）も同様にどの段階でも併用でき、付いている間は`claude-issue-dispatch.yml`（無人実行）がそのIssueに対して計画・実装・分割・追加対応を一切行わない（読み取り専用の質問応答のみ例外）。VSCode等のローカルClaude Codeセッションで対応するIssueに付けることで、ローカルと無人実行がラベル操作をきっかけに二重起動するのを防ぐ（詳細は[docs/multi-agent/branching.md](docs/multi-agent/branching.md)「ローカル実行と無人実行の二重起動を防ぐ」参照）。優先度ラベルは`11.local`と番号帯が重ならないよう`80.Priority: High`・`89.Priority: low`へリネームした。

`Release`・`Done`に対応するdevelop→mainのリリースフロー自体は、バージョンbump PR・develop→mainのPR作成までを`.github/workflows/release-develop-to-main.yml`が自動化している（詳細は[docs/multi-agent/release.md](docs/multi-agent/release.md)参照）。develop→mainの実際のマージは下記「自動マージ不可カテゴリ」に該当するため人間が手動で行う。

### ユーザーの手作業が残る場合は新規Issueとして起票する（`71.manual-step`ラベル）

実装の結果として、エージェントが代行できないユーザー自身の操作（本番サーバー上の`.env`の書き換え、GitHub Appの権限追加、1Passwordでのトークン発行、外部サービスの管理画面での設定など）が残る場合、**PR本文の「注意点」やIssueコメントに書くだけで終わらせず、その手作業を単独の新規Issueとして起票する。** 書くだけではPRがマージされ元のIssueが`Done`でcloseされた時点で追跡できなくなる。

- ラベル: `71.manual-step`（`00.check-user`とは併用しない）
- タイトル: `[手作業] <実行する場所>: <やること>`
- 本文: 「この作業でできるようになること」「前提条件」「やること（コピペで実行できるコマンド）」「完了の確認方法」「なぜエージェントが実施しないか」「関連（起点Issue・PR）」をこの順で書く
- 「この作業でできるようになること」は**本文の先頭**に置き、「できるようになること」と「実行するまでできないこと（いつまでに必要かを含む）」を書く。開く人は別の時点・別の端末にいて、その作業がどの機能を止めているのかを覚えていないため、手順より先に効果と急ぎ具合が分かるようにする（旧テンプレートの「放置するとどうなるか」はこの見出しへ統合した）
- 「やること」は**手順が2つ以上あるなら`- [ ]`のチェックリスト**にする（1手順＝1項目、コマンドは項目の下にインデントしたコードブロック）。GitHubでもissue-deckの画面でもクリックして消し込め、途中まで進めた記録が残る
- **端末をまたぐ作業は、各手順の文頭に`（サブPC）`のように実行する端末を書く**（#2052。`サブPC`・`メインPC`・`VPS`・`ブラウザ`の4つ）。画面のチップと代行実行の可否は手順ごとに切り替わる。書かなかった手順は「前提条件」の「実行するデバイス」を既定値として使い、そこに端末が複数書かれていると既定値が決まらないため代行の対象から外れる
- 「前提条件」には**実行するデバイス・カレントディレクトリ・Gitブランチ・先に完了している必要があるIssue／PR・その他の前提**を書く。実行する側は別の端末の前でこれを読むため、どれか一つでも欠けると実行してよいかを判断できない。**Gitブランチは原則`develop`**（本体チェックアウトがdevelopのため。例外は`develop`を持たないリポジトリと本番へデプロイ済みのコードを触る作業で、その場合だけ`main`）
- 「完了の確認方法」は**「やること」の手順と1対1のコマンド**で書き、それぞれに期待する出力を添える（#2256。「動作を確認する」で終わらせない）。**手順を実行したかではなく、実行した結果が入っているか**を確かめるコマンドにし、効いていなければ終了コードが0にならないものを選ぶ。ここに置いたコマンドだけが手作業アシスタントの代行実行と定期巡回の対象になり、確認が通った記録が無いままクローズしようとすると画面が1回聞き返す。画面の操作でしか確かめようがない場合だけ、どこに何が出ていれば完了かを書く
- 起点IssueへGitHubネイティブのサブIssueとして紐付け、起点IssueとPRにリンクをコメントする
- issue-deckのサイドメニューの「ユーザーの作業待ち」ビュー（`view=manual-step`）に集まる。**エージェントへ送り直すIssueではないため実装開始の導線は出ず**、実行したユーザーがIssue詳細の「手作業を完了してクローズ」でcloseする（進捗Statusは`Ready`のままでよい）

**ただし、次のどれかに当てはまるものは起票しない**（#2009）。**issue-deckの画面から実行できる操作**（サブPCのチェックアウト更新とpollerの再起動は「更新して再起動」で済む）、**同じ作業が繰り返し発生するもの**（発生のたびに起票せず、その作業をなくすIssueを立てる）、**openな同内容の手作業Issueが既にあるもの**（起票の前に`gh issue list --state open --label "71.manual-step" --search ...`で確認し、あれば既存Issueへコメントする）。この判断が無かった期間に、同じ内容の手作業Issueが5日で17件立っている。

判断基準・本文テンプレートの全文・設計理由は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「デプロイ後などに残るユーザーの手作業はIssueとして起票する」を参照。

### VPS・サブPCの設定ファイルの変更は、管理リポジトリのIssueへ切り出す

**実機のファイルを直接書き換える手順を、手作業Issueに書かない**（#2021）。Apacheのvhost・systemdユニット・cron・fail2ban・netplan・`~/.bashrc.local`といった設定は`guchi-apps/vps`・`guchi-apps/subpc`で管理されており、**`main`へマージすれば各リポジトリの`deploy.yml`が実機へ自動で反映する。** 手で書き換えると変更がGitに残らず、毎日のドリフト検知で後から差分としてだけ出てくる。

- 対応表の正は[`src/lib/infra-config-repos.ts`](src/lib/infra-config-repos.ts)。画面の手作業パネルも同じ判定で「リポジトリ経由で反映できます」を出す。載せるのは`deploy.yml`の`paths`に入っている受け口だけで、vpsの`mysql/`のような記録用ディレクトリは従来どおり手作業
- 該当する変更は**対象リポジトリへIssueを起票**して切り出し、起点Issueのサブissueとして紐付ける。**そのリポジトリでの実装（ファイルの変更・PR作成）は起票したセッションで行わない**（担当Issue以外の実装にあたる）
- **実機へ出るまでのマージは2回**（Issueブランチ→`develop`、`develop`→`main`のリリースPR。2段目は自動マージ不可カテゴリで人が行う）。手作業Issueには実機のコマンドではなく「切り出したPRのマージ→リリースPRのマージ→`deploy.yml`の成功確認」を書き、`## 前提条件`へ`guchi-apps/vps#<番号>`と書いて順序を残す

詳細（対応表・切り出しの流れ・画面の導線）は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「実機の設定ファイル変更は、管理リポジトリのIssueへ切り出す」を参照。

### ユーザー自身にコマンドを実行してもらうときは、Issueコメントに書く

権限や実行環境の都合でエージェントが実行できないコマンド（本番デプロイの`gh workflow run`、対話的なログイン、auto modeのクラシファイアにブロックされた操作など）が出てきて、**ユーザーに実行してもらってから作業を続けたい**場合、端末やワークフローのログに出すだけで終わらせない（#2002）。**端末の表示もActionsのログも通知にならず、ユーザーが見に来るまで誰も気付かない。**

Issueコメントとして投稿し、「なぜエージェントが実行できないか」「コピペで実行できるコマンド」「実行後にエージェントが何をするか」を書いたうえで`00.check-user`と理由ラベルを付ける。理由ラベルはローカルセッションが`01.check-input`（待機）、無人実行が`01.check-blocked`（その場で停止するため）。**`71.manual-step`の単独Issueにはしない**（あれはPRマージ後も残る手作業の追跡用で、セッション中に今すぐ実行してほしい1コマンドには重い）。詳細は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「ユーザーにコマンドを実行してもらうときは、Issueコメントにも書く」を参照。

### 新規アプリの立ち上げは画面の「新規アプリを立ち上げる」から行う

新しい個人アプリの立ち上げ（#2188）は、画面から相談 → 設定 → 確認と進めると、GitHubリポジトリの作成と残りの作業のIssue一式（初期化・`guchi-apps/vps`のVirtualHost・手作業3件）までを起票する。**手順の正は共有知識（`guchi-apps/docs`の`guides/new-app-checklist.md`）で、issue-deck側に手順を複製しない。**

- **ポートとホスト名は`guchi-apps/vps`の実物から決める。** READMEの2つの表（アプリ一覧・予約済みポート）と、vhostの`ServerName`／`ServerAlias`を読む。**READMEの散文の「空きは〜」とvhostのファイル名は読まない**（どちらも実態とずれる）
- **リポジトリを作った直後に雛形一式（ワークフローのcaller・CI・デプロイ・`CLAUDE.md`など）をコミットする**（#2247）。盤面へ載る条件は`claude-issue-dispatch.yml`がデフォルトブランチにあることで、以前はそれを作るのが初期化Issue自身だったため、初期化IssueだけがサブPCのローカルセッション専用になっていた。雛形の宣言は[`src/lib/new-app/scaffold.ts`](src/lib/new-app/scaffold.ts)にあり、**issue-deck自身が実物を持つファイル（`signaly-notify.sh`など）は写しを作らず`main`からそのまま配る**
- **自動化できないものは自動化したように見せない。** DNSのAレコードはVPS管理画面にAPIが無く、VPS実機の操作（`/apps/<name>/`・DB作成・PM2・certbot）は`guchi-apps/vps`の`deploy.yml`が配る受け口ではないため、どちらも手作業Issueとして残す
- 生成する手作業Issueの書式・失敗したときの扱い・盤面へ載るまでの順序は[docs/new-app-launch.md](docs/new-app-launch.md)を参照する

### Issue間の実施順序は`## 前提条件`に書く（`71.manual-step`以外も）

「AをやってからBをマージする」のように順序が決まっている場合、**PR本文の散文やIssueコメントに書くだけでは画面に出ない**（#2003）。**待つ側のIssueの本文**に`## 前提条件`の見出しを足し、`- 先に完了している必要があるIssue・PR: #39`のように**番号を`#39`の形で**書く（別リポジトリは`owner/repo#39`）。

- 書くのは**待つ側だけ**でよい。待たれる側のIssue詳細には「このIssueの完了を待っているIssue」が自動で出る
- 画面に出るのはIssue詳細の「実施順序」セクションと、Issue一覧の行の印（前提待ちなら橙の時計）
- **自動マージは止まらない。** マージ前に人の確認を挟みたい場合は`22.merge-confirm-required`を併用する

詳細は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「実施順序は`## 前提条件`に書く」を参照。

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

**ただしissue-deck自身のdevelop向けPRでは、`develop`→`main`を除く上記カテゴリで自動マージを止めない**（#2775）。`develop`はリリース前の統合先で、本番へ出るには`develop`→`main`のリリースPR（このカテゴリのまま・人がマージする）をもう1回通るため、develop向けPRの側で毎回「確認待ち」の札を積む価値が薄かった。切り替えは共有ワークフロー`reusable-claude-review-develop.yml`の`merge-policy`入力（`strict`＝既定・従来どおり／`relaxed`）で、issue-deckのcaller（`.github/workflows/claude-review-develop.yml`）だけが`relaxed`を指定している。**他リポジトリは`strict`のままなので、上のカテゴリがそのまま効く。**

`relaxed`でもdevelop向けPRのマージが止まるのは次の4つ。

- Issueに`22.merge-confirm-required`・`23.preview-required`・`24.screenshot-required`のいずれかが付いている
- `.shared-context/`（共有知識リポジトリのcheckout先）が差分に混入している
- Claudeの自動レビューが「実際に直すべき問題がある」と判定した
- `claude-review`・`auto-merge`ジョブ自体が失敗した（フォールバックが`00.check-user`を付ける）

**`relaxed`は「レビューを省く」ことではない。** カテゴリに該当したPRでは従来どおりClaudeの自動レビューが走り、止めるかどうかだけがレビューの判定に委ねられる。したがって、マージ前に必ず自分の目で通したい変更には`22.merge-confirm-required`を明示的に付ける（詳細は[docs/multi-agent/labels.md](docs/multi-agent/labels.md)「developへのマージ前確認要否をIssueラベルでトグルする」参照）。

**「GitHub Actionsやデプロイ設定」の唯一の例外は、issue-deckの画面から他リポジトリへ配る共有ワークフローの参照タグ更新PR**（`.github/scripts/propagate-workflow-tag.sh`が作るもの。#1602）。差分が`@workflows/vN`と`prompts-ref`の置換だけの機械的なPRで、配るタグ自体はissue-deck側で確認を通してから切っているため、配布先で見ても判断材料が増えない（14リポジトリぶんのPRを開いてマージするだけの作業になっていた）。**例外はこの配布PRに限られ、issue-deck自身のPRには一切適用しない。** 自動マージは画面のチェックボックスで外せる。

### PR本文テンプレート

`develop`宛のPRには以下を記載する。

- 対応Issue（`closes #番号`/`fixes #番号`は使わず`#番号`のみ記載する。developマージ時点ではissueをcloseしない運用のため）
- 実装内容
- テスト内容
- 確認方法
- 注意点
