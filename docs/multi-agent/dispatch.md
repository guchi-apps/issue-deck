# Phase 5: @claudeコメント起点の完全自動化

`.github/workflows/claude-issue-dispatch.yml`による無人実行の全体。トリガー・再開・通知・権限モード。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)


`.github/workflows/claude-issue-dispatch.yml`で実装済み。ローカルの`scripts/start-issue.sh`が行っている
作業（issue-<番号>ブランチ作成・実装・develop向けPR作成）をGitHub Actions上で無人実行する。

## トリガー

- Issueへの`@claude`コメント（起動トリガーはこれに一本化。旧`20.auto-implement`ラベルは廃止した）

パブリックリポジトリのため`@claude`コメント自体は誰でも投稿できる。トリガー経路によらず一律で
実行者(`github.actor`)のリポジトリ権限を`gh api repos/{owner}/{repo}/collaborators/{actor}/permission`
で確認し、write権限未満なら何もしない。

コメント本文とのマッチングは`contains()`ではなく`startsWith()`で行う（本文の先頭が`@claude`か
どうかのみ判定し、本文中のどこかに`@claude`という文字列が含まれるだけでは反応しない、#173）。
`contains()`だと、このワークフロー自身が投稿する完了報告コメント（承認コメントの定型文
`APPROVE_COMMENT_BODY`を説明のため引用する場合など）にまで反応し、報告コメントが次のワーク
フロー実行を誘発し、その実行がまた報告コメントを投稿して…という無限ループを起こしうる
（#173で実際に2回連続発生した）。アプリが送信する定型コメント（`APPROVE_COMMENT_BODY`・
`startImplementationCommentBody()`の返り値等）と、人間が手動で投稿する起動コメントはいずれも本文の
先頭が`@claude`という慣習のため、`startsWith()`に絞っても正規の起動経路は損なわれない。

なお`21.plan-required`の承認再開（`00.check-user`ラベルの削除）は引き続き`issues: unlabeled`
イベントをトリガーに使う（下記「二段階トリガー」参照）。ラベル付与（`labeled`イベント）はもはや
本ワークフローのトリガーには使わない。

## `21.plan-required`が付いている場合の二段階トリガー（再起動方法を確定）

「未解決の課題」に残っていた「②→③の具体的な再起動トリガー」を以下のとおり確定した。

1. **計画提示**: `21.plan-required`が付いたissueへの初回dispatch時は実装せず、コードを調査した計画を
   `gh issue comment`でissueに投稿し、`00.check-user`を付与して停止する。
2. **承認・再開**: 人間が計画を確認し、issueから`00.check-user`ラベルを外すと「承認」とみなし、
   同ワークフローが実装を再開する（`issues: unlabeled`イベントをトリガーに使う）。
3. **練り直し**: `00.check-user`が付いたまま（＝未承認）人間が`@claude`とコメントした場合は、計画への
   修正依頼として扱い、計画コメントを投稿し直す（`00.check-user`は外さない）。
4. **拒否**: 承認も練り直しもせず、計画自体を取りやめて実装しない場合は、人間が
   `gh issue close`（またはGitHub Web UI）でIssueを`not planned`等の理由で直接クローズする。
   クローズ済みのIssueは本ワークフローの全モードで再始動しない（`issue_closed`ガード）ため、
   拒否のコメント自体に`@claude`を含める必要はない（コメントを残さずクローズするだけでもよい）。
   クローズ後も`00.check-user`ラベルが「要確認」のまま残ると紛らわしいため、
   `.github/workflows/issue-labels.yml`の`cleanup-on-close`ジョブが、Issueクローズをトリガーに
   `00.check-user`を自動的に除去する（issue #172、#464）。**進捗（Project Status）は巻き戻さない**
   （`Done`のIssueを人が閉じ直しただけで盤面が`Ready`へ戻るのを避けるため。#991 Phase 5までは
   進捗ラベルの除去も行っていた）。この除去自体が`00.check-user`の`unlabeled`イベントを発生させ本
   ワークフローを起動するが、対象issueは既にクローズ済みのため`issue_closed`ガードにより
   何もせず`mode=skip`となる。

`00.check-user`はPhase4の自動マージ不可判定でも使われる汎用の「要確認」ラベルだが、対応issueの
PRが既に作成されている場合にのみ本ワークフローは常にskipし、それ以前の状態でのみ「承認」と
解釈するようガードしている（`gh pr list --head issue-<番号>`でPR有無を判定）ため、Phase4側の
判定（常にPR作成後にしか起こらない）と混線しない。

## 実装が詰まった状態からの再開（issue #112）

無人実行の実装ステップが権限拒否等で行き詰まり、PRもコメント投稿もできないまま終了することが
ある（issue #112で実際に発生。`permission_denials_count`が多数記録され、`issue-<番号>`ブランチは
pushされたがPRが作成されないまま終了した）。この場合、当時の実装（ブランチ有無だけで常にskipする
判定）では、PRが無いまま`issue-<番号>`ブランチだけが残り、以後どのイベントが来ても再始動しない
状態でスタックしてしまい、人間がブランチを手動削除する以外に復旧手段が無かった。

判定ステップでは「進捗が`Implementation`なのにPRが無い」状態を検知でき、当初はこれを詰まった実装の
リトライとみなして`issue-<番号>`ブランチを自動削除・作り直しした上で実装ステップを再実行していた。
しかし、これは「そのissueに来た@claudeコメントや00.check-user解除イベントなら何でも」トリガーに
なってしまい、実は前回コミットまで進んでいた作業が本人の意図に関わらず無言で失われる恐れがあった。

そのため、ブランチの削除・作り直しは自動化せず人間の明示操作（`git push origin --delete
issue-<番号>`等）に委ねたうえで、この詰まった状態を`mode=additional`（既存ブランチへの追加対応、
#129）に統合し、issue_commentでの呼びかけがあれば既存の`issue-<番号>`ブランチをそのままcheckout
して続きから自動的に再開するようにした。前回コミットを失うことなく、無駄なやり直しも避けられる。
実装ステップのプロンプト側で`git log develop..HEAD --stat`等により現在のブランチの状態をまず
確認させ、続行可能ならそのまま実装を続けて完了時に新規でPRを作成し、続行が難しいほど中途半端・
矛盾した状態だと判断した場合は無理に修正せず`00.check-user`を付与して人間に判断を委ねる。

## 着手直後の通知コメント

モード判定（plan/implement）が終わった直後に、`gh issue comment`で「依頼を確認し対応を開始する」旨を
issueに投稿するステップを設けている（issue #75）。Claude Codeエージェント自身に通知コメントの投稿を
委ねると、調査に時間がかかった場合や途中で行き詰まった場合に「依頼を受け取ったこと」自体が使用者に
伝わらない恐れがある。そのため後続のClaude Codeステップとは独立した、失敗しにくい単純なシェル
スクリプトのステップとしてモード判定直後に配置し、確実に投稿する（下記「計画提示ステップの信頼性
確保」のフォールバック検証と同じ考え方）。

この受付コメントの役割表示（下記`issue-deck-agent`マーカー）は、モードによらず常に`guide`で
統一している（#860）。plan/split/askはもちろん、additional・implementといった実装系モードでも
「受付」自体は案内であり、実際の実装作業の報告ではないため、受付時点では案内ボット名義とする。
一方、実装完了後にPR作成・追加コミットを報告する完了コメント（実装ステップ末尾で投稿）は実際の
実装作業の報告なので、引き続き実装ボット（`implementer`）名義のままとする。

### 質問（`mode=ask`）の受付コメントは、回答が出た時点で削除する（#1766）

質問だけは「質問 → 受付 → 回答」の3件が並び、回答が出たあとも受付コメントだけが役目を終えて
残っていた。そのため`mode=ask`に限り、**回答（または下記の「回答できなかった」通知）が投稿された
時点で、その実行が投稿した受付コメントを削除する**。画面のコメント欄には質問と回答だけが残る。

**投稿自体はやめない。** この受付コメントに含まれる`実行ログ: <URL>`は、issue-deckが実行IDを読み取る
唯一の手掛かりで（`src/hooks/use-issue-workflow-run.ts`・`src/lib/github/workflow-run-log.ts`）、
回答が出るまでの「実行中: N分経過」バッジと実行キャンセルボタン（`issue-status-card.tsx`）はこれに
依存している。投稿をやめると、回答を待っている間に実行の様子を追う手段もキャンセルする手段も失われる。
回答が出たあとは、回答コメント末尾の「実行ログ:」リンク（`.github/prompts/question.md`が必ず付けるよう
指示している）が同じ役目を引き継ぐ。

削除するのは**その実行が投稿した1件だけ**で、対象は`gh issue comment`が返したコメントURLの末尾から
取り出したidに限る（数字として取れなかった場合は削除しない）。削除に失敗してもジョブは落とさず、
警告のみ残す。plan/split/implement/additionalの受付コメントは従来どおり残す。

### 質問への回答は、回答マーカーの有無で検証する（#1766）

回答の検証（「質問への回答を検証し、受付コメントを片付ける」ステップ）は、**新しく投稿された
コメントに回答マーカー（`<!-- issue-deck-qa-answer -->`）があるか**で判定する。以前は「コメントが
1件でも増えたか」で見ていたため、実行中に人や別のワークフローがコメントすると件数だけが増え、
回答が無いまま「完了」と判定されていた。マーカーの付与はプロンプトの指示に依存するため、マーカーが
無くてもこの実行のトークン名義（`github-actions[bot]`）の新規コメントがあれば回答済みとして扱い、
警告だけ残す（回答が出ているのに失敗を通知する誤検知を避けるため）。

回答できなかった場合に投稿する通知は、末尾を`<!-- issue-deck-fallback-notice -->`にして
**エラー通知ボット（赤）** として表示する（以前は案内ボット名義で、失敗であることが色・アイコンから
分からなかった）。この通知は`isQaAnswerPending`（`src/lib/github/ask-claude.ts`）と
`updateQaAnswerPendingState`（`src/lib/github/sync-issues.ts`）でも回答待ちの終わりとして扱うため、
画面の「Claudeの回答待ち」表示もここで解除される（従来は回答コメントが来るまで永久に残っていた）。

## コメント投稿元・ボットの役割表示（`issue-deck-source` / `issue-deck-agent`マーカー）

issue-deckは1つのIssueに複数のワークフロー・複数のモードのボットコメントが積み重なるため、
issue詳細画面（`comment-thread.tsx`）はコメントを投稿者別に整理して表示する。ログイン中の
ユーザー本人のコメントは右寄せの吹き出し、ボットのコメントは役割ごとにアイコン・色を分けた
左寄せの吹き出しで表示し、ヘッダには（役割が判別できる場合）loginの代わりに役割の表示名を出す。

役割の判定は`src/lib/github/comment-source.ts`の`resolveCommentSource()` /
`commentAgentRole()`が行う。優先順位は次のとおり。

1. `<!-- issue-deck-fallback-notice -->`（`fallback-notice.ts`） → エラー通知ボット
2. `<!-- issue-deck-qa-answer -->`（`ask-claude.ts`） → 回答ボット
3. `<!-- issue-deck-plan-type:implement|split -->` → 計画ボット／分割ボット
4. `<!-- issue-deck-agent:<role> -->`（`role`は`implementer` / `splitter` / `guide`のいずれか） →
   指定された役割
5. `<!-- issue-deck-source:<id> -->`のうち`claude-review-develop` / `claude-conflict-resolve` /
   `issue-labels` → レビューボット／コンフリクト解消ボット／進捗通知ボット（`claude-issue-dispatch`
   はこのidだけでは役割が一意に決まらないため対象外。4のagentマーカーか、下記6の絵文字フォール
   バックで判別する）
6. 本文書き出しの絵文字（`🔍`→計画ボット、`🔧`→実装ボット、`🔀`→分割ボット、`ℹ️`→案内ボット） →
   マーカー導入前の過去コメント向けのフォールバック推測
7. 上記いずれにも該当しないbotログイン → 役割なしの汎用ボット（ヘッダにはloginをそのまま表示）
8. bot以外のログイン → 役割解決の対象外（人間のコメントとして表示）

`issue-deck-source`マーカー自体は#563/#564で導入済みの投稿元ワークフロー識別用マーカーで、本
`issue-deck-agent`マーカーとは別軸（source＝どのワークフローが投稿したか、agent＝その中の
どの役割か）として併記する。`claude-issue-dispatch.yml`は計画・実装・分割・案内のいずれのコメント
も同じ`claude-issue-dispatch`というsource idで投稿するため、agentマーカーが無いと役割まで
区別できない。他の3ワークフロー（`claude-review-develop` / `claude-conflict-resolve` /
`issue-labels`）はsource idだけで役割が一意に決まるため、agentマーカーは付与していない。

**新しくボットコメントを追加する場合は、上記の優先順位のどれか1つに当てはまるマーカーを必ず
本文末尾に付与すること。** 特に`claude-issue-dispatch.yml`に新しいコメント種別を追加する場合、
1〜3のいずれにも該当しないなら`<!-- issue-deck-agent:implementer|splitter|guide -->`のいずれかを
選んで付与する（迷った場合は、実装作業そのものに関する通知なら`implementer`、それ以外の案内・
状態通知なら`guide`を選ぶ）。マーカーを付け忘れると、絵文字フォールバック（6）に頼ることになり、
文言を変えるだけで表示が壊れる脆い状態になる。

各役割のアイコン・色は`src/lib/github/comment-source.ts`の`COMMENT_AGENT_PROFILES`に集約している。

## 「Claudeアプリで開く」は削除した（#1769）

無人実行が行き詰まったときの逃げ道として、Issue詳細に`claude.ai/code`を開くボタン（#360）と、
押下時に引き継ぎ記録コメントを投稿する仕組み（#412）を置いていたが、**質問する**（Issue上で
Claudeに聞く）と**サブPCで実行する**（ローカルセッションの起動）で用途が代替されたため削除した。
`src/lib/github/claude-app.ts`ごと消しており、過去に投稿された
`<!-- issue-deck-claude-app-handoff -->`付きのコメントを解釈する経路も残っていない。

なお「UI側（issue-deckアプリ自身）が確実にコメントを投稿してから遷移する」という考え方自体は
上記「着手直後の通知コメント」と共通で、エージェント側の気配りに頼らない記録の作り方として
引き続き有効である。

## 無人実行時の権限モード（許可ツールリスト）

- **計画提示ステップ**: `--allowedTools "Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh issue edit:*),Bash(gh issue create:*),Bash(gh pr list:*),Bash(gh api:*),Bash(git ls-remote:*),Bash(git log:*),Bash(curl:*),Read"`。
  コード変更ツール（Edit/Write）は許可しない（計画提示のみで実装はしないため）。当初`gh issue`系3種のみを
  許可していたが、計画立案のための調査で`git ls-remote`・`gh pr list`・`gh api`（関連PR・ブランチ状況の確認）
  を試みて未許可コマンドとして拒否され続け、ターン数を使い切ってコメント投稿・ラベル付与に到達できない
  失敗が実際に発生した（Issue #70で確認）。読み取り専用の調査コマンドを許可リストに加えて解消した。
  `gh issue create`は、元Issueのスコープ外の関連事項を独立Issueとして提案・起票できるようにするため
  追加した（#735。詳細は上記「実装範囲が広いIssueをサブIssueに分割する」節末尾を参照）。
- **質問応答ステップ**: `--allowedTools "Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh issue create:*),Bash(gh pr list:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh api:*),Bash(git ls-remote:*),Bash(git log:*),Bash(curl:*),Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Read,Grep,Glob"`。
  コード変更ツール（Edit/Write）と`gh issue edit`・`gh issue close`は許可しない。質問された
  Issue自体の進行を動かさないため、**既存Issueに対しては回答コメントを投稿するだけ**にする。
  `gh issue create`だけは例外で、質問に答える過程で見つけた別件を起票できるようにするために
  許可した（#1528）。回答コメントに書くだけで終わらせるとどのカンバンにも残らず追跡できなくなる
  ためで、ルール（`70.confirm`付き・「起点: #<質問Issue番号>」を明記・目安3件まで・起票しても
  実装はしない）は計画提示ステップ（#735）に揃えてある。本文は
  [.github/prompts/question.md](../../.github/prompts/question.md)。ローカルの横断質問セッション
  （[subpc-dispatch.md](subpc-dispatch.md)）も同じルールで、あちらは`--disallowedTools`側で
  `Edit,Write,NotebookEdit`を封じている
- **実装ステップ**: `--allowedTools "Edit,Write,Read,Bash(git:*),Bash(gh:*),Bash(pnpm:*),Bash(npx:*),Bash(curl:*)"`。
  `--dangerously-skip-permissions`等の全許可フラグは使わず、必要なツール・コマンドプレフィックスのみを
  明示的に許可する方針（Phase1〜4から継続）。
- `Bash(curl:*)`・`Read`は、issue本文に貼り付けられた画像がissue-deck独自の画像アップロードAPI
  （`user-images.githubusercontent.com`等のGitHub純正CDNではなく`/api/issues/images/...`）経由の場合、
  claude-code-action組み込みの画像取得機能の対象外となり素通りしていた問題への対応として追加した
  （Issue #195）。`WebFetch`はHTMLをMarkdown化して要約する用途向けで画像本体をClaudeに見せられないため、
  代わりに`curl`でローカルに保存し`Read`で開く方式にした。`Bash(curl:*)`はURL・HTTPメソッドを問わず
  任意の外部通信を許可してしまう（シークレットの外部送信等）ため、より狭い許可（ドメイン限定や
  GET専用化）が理想だが、Bashの許可ルールはコマンド文字列の前方一致でしか絞り込めずフラグの
  順序次第で回避されてしまう。本ワークフローは既に`Bash(git:*)`・`Bash(gh:*)`など広い許可を与えており
  （信頼された運用者のIssueのみを想定した既存の前提を踏襲）、`curl`もその前提の範囲内として許可した。
- git push（ラベル操作を含む）は、Workflows: Read and write を持つワークフロー用トークンで行う
  （issue #106）。既定の`GITHUB_TOKEN`は
  `.github/workflows/`配下へのpushをGitHubの仕様上原理的に許可できない（リポジトリの
  「Workflow permissions」設定をRead and writeにしても解除されない）ため、`.github/workflows/`
  自体を変更するIssueを本ワークフローで扱うにはこのトークンが必須。
  **中身は#835でGitHub Appのインストールトークンへ変わった**（`WORKFLOW_APP_ID`が未登録の
  リポジトリでは従来の`secrets.WORKFLOW_PAT`へフォールバックする。
  [actions-token-model.md](../actions-token-model.md)「8. 案Bへの移行（#835）」）。
  この認証は`Checkout develop`ステップの
  直後に置いた`pushの認証をワークフロー用トークンに固定する`ステップ（`git remote set-url --push origin`で
  `remote.origin.pushurl`にトークンを埋め込んだURLを設定する）で完結しており、後続の実装ステップ
  （`claude-code-action`）側の`github_token`入力・`GH_TOKEN`環境変数には依存しない。他のステップ
  （状態判定・通知コメント・計画提示など、ワークフローファイルを変更しない箇所）は既定の
  `GITHUB_TOKEN`のままとし、PATの利用は最小限にとどめている。
  - 実装ステップの`GH_TOKEN`環境変数（および`github_token`入力）は、上記のとおりgit pushの認証には
    使われないため、そのまま既定の`GITHUB_TOKEN`（`${{ github.token }}`）を設定している。これにより
    `gh issue comment` / `gh pr create` / `gh pr comment` / `gh issue edit`はすべてトークンを
    上書きせずそのまま実行すればよく、投稿者・作成者は`github-actions[bot]`になる。同じパターンが
    使われる`.github/workflows/claude-conflict-resolve.yml`のコンフリクト解消ステップも同様の方針
    にしている。
  - 当初（issue #576時点）は`GH_TOKEN`を`WORKFLOW_PAT`（人間（m-guchi）名義のFine-grained PAT）に
    設定したうえで、Issue/PRへのコメント投稿・PR作成のみコマンド単位で`DEFAULT_GH_TOKEN`
    （既定の`GITHUB_TOKEN`）に明示的に上書きさせるようプロンプトで指示する方式を取っていた。しかし
    実際にはClaude Codeのbashツール自体が持つシークレット保護のガードレールが、`TOKEN`を含む名前の
    環境変数の展開を一律ブロックするため、この上書きは実行時に機能せず、完了報告コメント・PRの
    投稿者が人間（m-guchi）名義のまま記録され続ける問題が再発した（issue #621）。そこで
    「git pushの認証はcheckoutステップ側で完結しており実装ステップの`GH_TOKEN`には依存しない」と
    判断し、コマンド単位の上書きという壊れやすい方式をやめて既定の`GITHUB_TOKEN`をそのまま使う
    構成に変更した（issue #635）。
  - しかしこの「checkoutステップ側で完結している」という前提は誤りだった（issue #662）。
    `claude-code-action`は実行時に`replaceCheckoutCredentials()`で、`actions/checkout`が残した
    `http.<server>/.extraheader`を削除したうえで`remote.origin.url`を
    `https://x-access-token:<action自身のトークン>@github.com/...`に差し替える。`github_token`
    入力を省略した場合のそのトークンはOIDC交換で得たClaude GitHub Appのインストールトークンであり、
    `workflows`権限を持たないため、`.github/workflows/`配下を含むpushだけが
    `refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`
    で拒否されるようになった（issue #622・#638・#652が実際にこれで停止した）。
    一方で`github_token`に`WORKFLOW_PAT`を戻すと、`claude-code-action`が実装ステップの`GH_TOKEN`も
    同じPATへ上書きするため（`src/entrypoints/run.ts`）、issue #621の「投稿者が人間名義になる」問題が
    再発する。actionに渡すトークンは1本しかなく「pushはPAT・コメントはbot」を両立できないため、
    actionが書き換えないpush専用URL（`remote.origin.pushurl`）にだけPATを固定する方式に変更した。
    fetchはaction自身のトークン、pushはPATという分離が成立し、プロンプト側は
    `git push origin <ブランチ名>`のままでよい。

## 既知の制約・今後の検討事項

- **develop向けPR作成後、Phase3/4のレビュー・自動マージが自動発火するか未検証**: `WORKFLOW_PAT`への
  切り替え（前述）により、`claude-issue-dispatch.yml`が作成するPRは既定の`GITHUB_TOKEN`ではなく
  実PAT由来になったため、GitHub仕様上の「`GITHUB_TOKEN`によるpush/PR作成は他のワークフローを
  起動しない」制限は受けなくなった。そのため`claude-review-develop.yml`（Phase3/4）が自動発火する
  可能性があるが、実運用でまだ確認できていない。Phase5の完了条件は「develop向けPR作成まで」であり、
  developへのマージまでの自動化は前提にしていないため、発火してもしなくても許容する
  （実装ステップ後のシェルステップが実際のPR状態を見て`Develop PR`を報告するため、自動発火に依存しない）。
- **GitHub Auto-mergeによるdevelopマージ後、`Develop PR`が`Develop`へ遷移しないことがある**
  （Issue #112、対応済み）: 上記と同根の制約で、`claude-review-develop.yml`の`auto-merge`ジョブが
  既定の`GITHUB_TOKEN`で有効化していたGitHub Auto-merge機能による実際のマージは、
  `issue-labels.yml`の`develop-pr-merged`ジョブ（`pull_request: closed`トリガー）を起動しないこと
  があった。対応として`auto-merge`ジョブの`GH_TOKEN`を`WORKFLOW_PAT`に切り替え、あわせて
  `issue-labels.yml`に`schedule`（15分おき）で走査する`develop-merge-sweep`ジョブを追加し、
  取りこぼした`Develop PR`を拾い直す安全網とした。PATへの切り替えで根本解消したかはGitHubの
  非公開の内部仕様に依存するため確証がなく、安全網を併設することでリスクを吸収している。
  **この安全網は#2294でissue-deck側の巡回（`POST /api/issues/progress-sweep`）へ移した**
  （Actionsのcronはジョブ単位で1分未満切り上げの課金になるため。
  [github-billing.md](../github-billing.md)）。走査の中身は変わっていない。
- `24.screenshot-required`が付いたissueをPhase5経由（無人実行）で処理する場合は、Phase7で統合した
  Playwright撮影（#258）により、実際にスクリーンショットを撮影してIssueコメントに埋め込んだ
  うえで通常どおり完了処理（PR作成）まで進める（PR作成自体はブロックしない。スクリーンショットは
  PR側ではなくIssue側のスレッドに集約する、#589）。ただし developへの
  実際のマージは`risk-check`ジョブの判定を受けて`auto-merge`ジョブが`00.check-user`を付与するため、人間がスクリーンショットを
  確認するまで保留される（#567）。詳細はPhase7参照。
- `23.preview-required`が付いているissueをPhase5経由（無人実行）で処理する場合（対応済み、#813・
  #832）: `24.screenshot-required`と同様の考え方で、それを理由にPR作成をブロックしない方式に
  統一した。実装・テスト完了後は通常どおり完了処理（PR作成またはPRコメント投稿）まで進める。
  #813時点では、無人実行環境から実際に到達可能なプレビューURLを提供できなかったため、完了報告
  コメントには人間が手元でブランチをcheckoutして`pnpm dev`を起動した際に開くURL
  （上記のポート割り当て規約`PORT=4000 + Issue番号`に基づく案内）を貼るだけの運用だった。その後#832でFly.io Machines上のプレビュー環境（#826・#830・#831）へ接続し、
  無人実行から実際に開けるプレビューURLを自動投稿するようになったが、#1265でサブPC上の
  ローカルセッションが`tailscale serve`でtailnetへ開発環境を出す方式へ移行したため、Fly.io側は
  #1308で廃止した。現在、無人実行からプレビューURLを発行する経路は無い。developへの実際のマージは
  `risk-check`ジョブが`23.preview-required`を検知し`auto-merge`ジョブが`00.check-user`を付与するため、人間が画面を
  確認するまで保留される点は変わらない。
