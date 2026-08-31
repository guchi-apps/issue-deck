# 実装セッションの状態通知とRemote Control

サブPC（`subpc`）のtmuxで動く実装セッションが、入力待ちと応答終了を自分からissue-deckへ
報告する仕組み（#1219）。あわせて`--remote-control`で、気づいた側がスマホやブラウザから
そのセッションへ答えられるようにする。

**#2280でSignalyへのwebhook通知を削除した。** 人へ届けるのはissue-deck自身のPush通知
（`00.check-user`が付いたIssueを鳴らす。`src/lib/notifications/`）で、このスクリプトが外へ
出す先はissue-deckのAPIだけになった。以下で「報告」と書いているのはすべてissue-deck宛で、
`~/.config/issue-deck/notify.env`にあった`SESSION_NOTIFY_WEBHOOK_URL`は無くなっている。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## なぜポーリングをやめるのか

これまでセッションの状態を知る手段は「メインPCから`ssh subpc tmux capture-pane`を定期的に
読み、画面の文字列から状態を推定する」ポーリングしか無かった。次の限界がある。

- 45〜60秒の遅延がある
- **見ている人がいる間しか機能しない。** 夜間に入力待ちで止まっても翌朝まで誰も気づかない
- **画面の文字列からの推定なので誤判定する。** 実際に「プランモードではフッターが
  `esc to interrupt` にならない」ことに気づかず、作業中を「停止」と誤って通知した
- 常時SSHを張るコストがかかる

Claude Codeのフックはイベント発生の瞬間にコマンドを実行するので、遅延も誤判定も無くなり、
見ている人がいなくても飛ぶ。

```text
tmuxの実装セッション（run-issue-session.sh が起動）
  │ 承認プロンプト・AskUserQuestion → Notification フック
  │ 人が答えて作業へ戻った           → PostToolUse フック（#1357。入力待ちの直後だけ扱う）
  │ 応答終了                        → Stop フック
  ↓
scripts/session-notify.sh（フックのstdinでJSONを受け取る）
  ├→ ~/.local/state/issue-deck/sessions/<tmuxセッション名>.event へ最後のイベントを記録（#1256）
  ↓ POST /api/dispatch/sessions/activity（~/.config/issue-deck/dispatch.env の APP_BASE_URL）
issue-deck → 画面に様子を出す＋入力待ちなら 00.check-user
  ↓ Push通知（src/lib/notifications/check-user-push.ts）
スマホ・メインPC → タップでそのIssueが開く
  ↓ 画面のパネル、または Remote Control のリンク
claude.ai/code/<セッション> （--remote-control）→ その場で答える
```

### 通知とは別に、ホストへも記録する（#1256）

セッションの自動回収は「最後の`Stop`からどれだけ経ったか」「今は人の入力待ちか」を判定材料に
するが、**通知を投げるだけではホストに何も残らない**。そこで`session-notify.sh`は、送信の前に
`<epoch> <Stop|permission_prompt|working>`の1行を状態ファイルへ書く。

`working`（#1357）は「入力待ちに人が答えて作業へ戻った」。**この記録は回収の判定材料であると
同時に、`PostToolUse`を間引く鍵でもある**（後述）。回収側から見れば`Stop`以外なので、
`permission_prompt`と同じく畳まない側に倒れる。

**記録は報告より前に行う。** 送信先の判定を先に置くと、報告先を設定していないホストで
記録も行われず、回収がまったく効かなくなる。記録の失敗は1行のログに留め、報告もセッションも
止めない。書式と使い道は
[作業が終わったセッションは自動で畳む](local-quick-start.md#作業が終わったセッションは自動で畳む1256)を参照。

## 計画はIssueのコメントへ残す（#1342）

**`21.plan-required`のIssueをここで起こすと、計画はセッションの中にしか残らなかった。**
画面に出るのは「入力を待っています」というバッジだけで（後述の#1264）、中身はRemote Controlを
開くまで見えない。プロンプト（`scripts/prompts/implementation-agent.md`）は計画をIssueへ投稿する
よう指示していたが、**エージェントが従うかどうかに依存していて担保が無い。**

そこで`ExitPlanMode`の`PreToolUse`フックで計画本文を掴み、issue-deckを経由してIssueへ書く。

Codexには`ExitPlanMode`が無いため、#2545では同じAPIを`scripts/submit-plan.sh`から呼ぶ。エージェントが
計画ファイルを明示して実行し、`SessionPlanRequest`の判断を自分のコマンド結果として受け取る。
画面・Issueコメント・ラベル・保存する状態はClaude Code経路と共通で、違うのは入口と結果の形だけ。

```text
Codexが計画ファイルを作る → scripts/submit-plan.sh <計画ファイル>
  → POST /api/dispatch/sessions/plan → Issueコメント・待機ラベル・承認パネル
  → GET /api/dispatch/sessions/plan/decision?id=… を引いて待つ
  → 承認: 終了コード0 ／ 修正: 終了コード0＋修正本文 ／ 期限切れ・通信継続失敗: 終了コード3
```

**期待される未決定を成功にしない。** Claude Codeはフックを抜ければ端末の承認プロンプトへ倒れるため
フェイルオープンでよいが、Codexにはそのプロンプトが無い。期限切れや通信失敗を終了コード0にすると、
エージェントが承認済みと誤認して実装へ進みうるため、Codexのコマンドは非0で止める。

**このコマンドは、フックと違って「エージェントが従うかどうか」に戻る**（#2551）。#2545では
Codex向けの手順を末尾の読み替え（`scripts/prompts/codex-supplement.md`）にだけ置いたため、本文に
残っていたClaude Code前提の手順（「フックが自動で投稿します／無ければ手で投稿します」）の方が
強く読まれ、計画が`gh issue comment`で手投稿されて承認パネルが出なかった。手順が変わるものは
本文側をエージェント別に差し替える（`{{PLAN_INSTRUCTIONS}}`・`{{PLAN_COMMENT_NOTE}}`。
[codex.md](codex.md)「手順が変わるものは、末尾の読み替えに書かず本文を差し替える」）。

**宛先と鍵（`APP_BASE_URL`・`DISPATCH_SECRET`）は`dispatch.env`から読む。** `notify.env`には無い
（そちらは待ち時間などの調整値だけ）。`session-notify.sh`・pollerと同じ場所で、環境変数は
tmuxサーバーの起こされ方によって届かないことがあるためファイルを正とする。

```text
ExitPlanMode（計画の提示）
  → PreToolUse フック → session-notify.sh
       → POST /api/dispatch/sessions/plan
            → Issueへ計画コメントを投稿（末尾にRemote Controlのリンク）
            → 00.check-user を付与
       → ホストに「ラベルを付けた」印を残す（<セッション名>.check-user）
            → 返事待ち（SessionPlanRequest）を作り、そのidを返す（#2061）
       → ホストに「ラベルを付けた」印を残す（<セッション名>.check-user）
            → 00.check-user ＋ 01.check-plan を付与（＝Push通知が鳴る）
       → GET /api/dispatch/sessions/plan/decision?id=… を3秒おきに引いて待つ
  → 人がissue-deckの画面で「承認」／「修正を送る」を押す
       → allow＋updatedInput ／ deny＋修正の本文 を返す（＝承認プロンプトは出ない。#2121）
  → 実装 ／ 計画の練り直し → Stop
       → POST /api/dispatch/sessions/activity に planResolved: true を添える
            → 00.check-user を除去
       → 印を消す
```

**返事が決まらなければ何も返さず、従来どおりの経路へ倒れる。**

```text
（待ち時間切れ／「端末で答える」／issue-deckが応答しない）
  → フックは何も出力せずに終える
  → 承認プロンプト（Notification）→ 従来どおりの入力待ち通知・画面表示
  → 人がRemote Controlで承認 → 実装 → Stop
```

- **計画をIssueへ残せる唯一の機会が`ExitPlanMode`の`PreToolUse`。** 承認プロンプトの
  `Notification`のJSONには計画に関する情報が何も無い。`PreToolUse`にmatcherを付けるのは
  このためで、付けずに置くと`Read`・`Bash`のたびにスクリプトが起動する
- **人へ届けるのは`00.check-user`とPush通知**（#2061・#2280）。従来はここで何も飛ばさず、
  直後に飛ぶ承認プロンプトの`Notification`に任せていた（同じ「入力待ち」が二重になるため）。
  画面から承認できるようになると、承認された場合は承認プロンプトが出ない＝`Notification`が
  飛ばないため、任せたままだと**計画が出たことが誰にも通知されない**。待ちを作るのと同じ
  往復でラベルまで付けきることが、気づける唯一の経路になる
- **リンクは計画本文の下に、別の段落として置く。** 計画が長いほど、末尾に出口が無いと
  「読んだ後どうすればよいか」が画面から消える
- コメント本文の組み立ては`src/lib/dispatch/session-plan.ts`。GitHubへ書く経路は異常終了の
  引き上げ（`session-escalation.ts`）と同じで、**サブPCにGitHubの認証を持たせない**

### 承認・修正は画面から送れる（#2061）

**`send-keys`は使わない。** 計画を投稿したフックがそのまま画面の返事を待ち、決まった内容を
**Claude Code自身の許可判定**（`hookSpecificOutput.permissionDecision`）として返す。承認なら
`allow`（承認プロンプトを出さずに実装へ進む）、修正なら`deny`＋書かれた本文
（`permissionDecisionReason`。Claudeがそれを読んで計画を練り直す）。承認プロンプトの選択
フォームに答えさせる操作はどこにも無いため、[gates.md](gates.md)の「実行体が判断して組み立てた
文字列・確定キーの送出」の禁止に触れない。

**承認（`allow`）には`hookSpecificOutput.updatedInput`を必ず添える**（#2121）。Claude Codeは
`ExitPlanMode`を**「許可が下りていても人へ聞き直す」ツール**（内部の`requiresUserInteraction`）
として扱っており、`allow`だけを返しても承認プロンプトが出る。**フックが`updatedInput`を
返したときだけ、その聞き直しを省く。** 添えるのは受け取った`tool_input`そのままで、中身は
変えない（「入力を差し替える」機能の副作用を借りているだけで、計画本文を書き換える意図は無い）。
`deny`はもともと聞き直されずClaudeへ渡るため添えない。

- **添え忘れると二重承認に戻る。** #2061の実装は`allow`だけを返していたため、画面で承認した
  あとRemote Controlでもう一度おなじ計画を承認する必要があった。転記の`hook_success`と
  `tool_result`のtimestampを比べると差がそのまま出る（実測で95秒・8分の例がある）。
  境界は`scripts/session-notify-plan.test.mjs`が固定している
- **公開仕様ではない。** 挙動はClaude Code 2.1.239のバイナリで確かめたもので、将来変わりうる。
  変わっても端末に従来どおりの承認プロンプトが出るだけで、セッションは詰まらない
- **画面から答えられるのは、待っている間だけ。** 待ち時間（既定30分）が切れると`EXPIRED`に
  なり、端末に従来どおりの承認プロンプトが出る。画面には残り時間がカウントダウンで出る
- **待っている間、端末には承認プロンプトが出ない。** 端末に座っていて先に進めたいなら、
  画面の「端末・Remote Controlで答える」を押す。**`Esc`は逃げ道にならない**（#2189で実測）
  ——待ちを抜けてプロンプトへ戻るのではなく**turnごと打ち切られる**（`ExitPlanMode`なら
  計画の提示が無かったことになり、続きは指示し直しになる）。ここは当初「`Esc`で中断すれば
  すぐプロンプトへ戻せる」と書いていたが、実際の挙動は違う
- **端末と画面の両方で同時に答えられるようにはできない。** 端末の承認プロンプトはフックが
  返った後にしか出ず、出たあとにそれへ答えられるのは端末（とRemote Control）だけ——画面から
  そこへ届かせる手段は`send-keys`しかなく、[gates.md](gates.md)で禁じている（選択フォームへ
  組み立てた文字列を送って1問目が勝手に回答済みになった事故がある）。したがって
  **「待っている間は画面が正、降りたら端末が正」を確実に切り替える**のが取れる最善で、
  切り替わったことは画面（「端末に承認プロンプトを出しました」＋Remote Controlのリンク）に出す
- **フェイルオープン。** issue-deckが応答しない・返事待ちを作れなかった・`planRequestId`が
  返らなかった、のいずれでも待たずに終える。**この機能が壊れてもセッションは詰まらない**
- **ただし1回の失敗では降りない**（#2108）。宛先は本番のissue-deckで、30分待つあいだに
  数百回引くため、瞬断や再起動で1回外すことは普通に起きる。**降りるのは届かない状態が
  `SESSION_PLAN_POLL_GRACE_SECONDS`（既定60秒）続いたときだけ**
- **降りるときは画面の待ちも畳ませる**（#2108。`POST /api/dispatch/sessions/plan/decision`）。
  伝えないと画面は待ち時間いっぱいカウントダウンを出し続け、**押しても誰も受け取らない
  ボタン**が残る。この往復の応答は最後の確認も兼ねていて、降りる直前に押されていれば
  その結論をそのまま許可判定として使う
- **返事待ちを作るかどうかは、Issueコメントを投稿できたかとは切り離す**（#2108）。パネルが
  描いているのはDBに保存した計画本文で、コメントの取得には依存していない。コメントを
  書けなかったことを理由に待ちを作らないと、**端末には計画が出ているのに画面からは承認も
  修正もできない**という、いちばん困る組み合わせになる
- 待ち時間は`~/.config/issue-deck/notify.env`の`SESSION_PLAN_WAIT_SECONDS`（質問は
  `SESSION_QUESTION_WAIT_SECONDS`。#2189）（秒。`0`で待たない。
  60〜3600の範囲へissue-deck側が丸める）。`ExitPlanMode`のフックだけ`timeout`を延ばして
  あるのはこのため（`scripts/run-issue-session.sh`。**打ち切られても壊れない**）
- 押した内容（承認・修正・端末で答える）は**Issueコメントとしても残る**。投稿はissue-deckの
  GitHub App名義になるので、末尾の投稿者マーカーで押した本人の発言として画面に出す
- **画面の導線もアプリの中で完結させる。** 計画の返事を待っている間は、Issue一覧の行に
  「計画を承認」（押すとそのIssueが開く）を出し、**Remote Controlの強調（#1964のamber）は
  下ろす**。Issue詳細の確認待ちの案内は「計画へ移動」でパネルまでスクロールし、コメント欄の
  案内も「上の『計画の承認を待っています』から送れます」に変わる。ここを直さないと、
  **アプリで承認できること自体が画面のどこからも読み取れない**
- **パネルはPC版・スマホ版の両方の詳細に置く。** Issue詳細は`issue-detail.tsx`と
  `mobile/mobile-issue-detail.tsx`で別のコンポーネントで、片方へ足しただけでは
  もう片方が従来どおりの案内のままになる（置き忘れは`plan-approval-mount.test.ts`が捕まえる）
- **押した結果は「どの計画に対して押したのか」まで持つ**（#2158）。**Issue詳細はIssueを
  切り替えてもアンマウントされない**（`issue-deck-shell.tsx`は`<IssueDetail>`に`key`を
  付けていない）ため、パネルが「承認した」とだけ覚えていると、別のIssueの計画・出し直された
  計画に差し替わってもその表示が残る。実際に、**上に「計画の承認が必要です（待機中）」、
  下に「承認を送りました」が同時に並び、押していない計画が承認済みに見える**状態が出た。
  押した結果は`request.id`と対で持って照合し、詳細側も`key={planRequest.id}`でパネルごと
  作り直す（書きかけの修正本文が別のIssueへ持ち越されるのも同時に防げる）。
  Issue固有の状態を持つ子コンポーネントを詳細へ足すときは同じことが起きうる
- **修正には画像を添付できる**（#2425）。入力欄は`MentionTextarea`なので貼り付け・
  ドラッグ&ドロップ・「画像を添付」がそのまま使え、画面の直しを頼むときに
  スクリーンショットや手描きのラフを1枚渡せる（文章で書き起こすより速くて正確）。
  **文字数の上限（2000）を数えるのは人が書いた文章だけ**で、末尾に並ぶ画像記法は
  枚数（10枚）で抑える——URLが1枚100文字前後を食うため、同じ枠で数えると
  「3枚貼っただけで書ける文章が1割減る」ことになる。**画像だけ（文章なし）でも送れる。**
  - **フックが運べるのは文字列だけで、画像そのものは渡らない。** URLをそのまま置くと
    Claudeは「URLが書いてある」ことしか読み取れないため、`revisionText`を返すときに
    取りに行き方（`curl`で落として`Read`で開く）を`buildPlanRevisionReason`が添える。
    `WebFetch`ではなく`curl`＋`Read`なのは、`WebFetch`がHTMLをMarkdown化して要約する
    ツールで画像そのものを見せられないため（#195と同じ理由。[dispatch.md](dispatch.md)）
  - **定型文を差し込む先は本文で、添付の後ろではない。** 末尾へ足すと画像記法の下に文が
    来て添付として読めなくなり、サムネイルが消えて本文にURLが出る
- サーバー側は`src/lib/dispatch/session-plan-request.ts`（値の検証・表示の判定）と
  `src/lib/dispatch/plan-requests.ts`（DB）。画面は`plan-approval-panel.tsx`、
  一覧の導線は`issue-list.tsx`＋`lib/remote-control-attention.ts`、案内の文言は
  `lib/github/check-user-guidance.ts`

### フックが何をしたかは転記の`hook_success`で追える

**フックの標準出力・標準エラー・所要時間・終了コードは、転記（`~/.claude/projects/<スラッグ>/<セッションID>.jsonl`）に
`{"type":"attachment","attachment":{"type":"hook_success",...}}`として残る**（#2108で判明）。フックは
端末に何も出さないまま終わることがあり、issue-deckにも残らないため、**ここが唯一の記録**になる。

```bash
python3 -c '
import json, sys
for line in open(sys.argv[1]):
    hook = (json.loads(line).get("attachment") or {})
    if hook.get("type") == "hook_success":
        print(hook["hookName"], hook["durationMs"], repr(hook["stderr"]))
' <転記のパス>
```

「計画の返事待ちが108秒で降りていた」も、`durationMs: 107886`と
`stderr: session-notify: 計画の返事をissue-deckから取得できませんでした`から確定させた。
**フックの挙動を疑ったら、まずここを見る。**

### 計画本文は`ExitPlanMode`の引数では渡ってこない（版による）

**Claude Code 2.1.239の実測では`tool_input.plan`に本文が入っていた**（#2108）。下に書いた
「渡ってこない」は当時の実測で、**版によって変わる**。引数にあればそれを使い、無ければ転記から
探す二段構えはそのまま残す——どちらかに寄せると、寄せた側でない版に当たった時点で計画が
載らなくなる。

**計画は`~/.claude/plans/<スラッグ>.md`にある。** plan modeに入るとClaude Codeがそのパスを
エージェントへ指示し、エージェントが`Write`／`Edit`で書く。`ExitPlanMode`は**そのファイルを
読むだけで、計画を引数に取らない**（ツールの説明にも「This tool does NOT take the plan content
as a parameter - it will read the plan from the file you wrote」とある。実測でも
`tool_input`は空）。当初は`tool_input.plan`から取るつもりで書き、動かなかった。

そこで`session-notify.sh`は、フックのJSONにある`transcript_path`を末尾から読み、
**エージェントが最後に`Write`／`Edit`した`~/.claude/plans/`直下の`.md`**を計画ファイルとみなす。

- **ツールの引数（`tool_use`ブロックの`input.file_path`）から拾い、本文の文字列一致では
  探さない。** 転記ファイルにはコマンドの出力も引用も入るので、「`~/.claude/plans/`配下の
  パスらしき文字列」を拾うと、**別セッションの計画ファイルの話をしただけの行**を掴む
  （実際に踏んだ）
- 末尾から探すのは、却下されて書き直された場合に新しいものが後ろに来るため。転記ファイルは
  数MBになりうるので末尾8MBだけを読む
- 引数で渡ってくる版に当たった場合はそちらを優先する（版差に強くしておく）
- **読めなければ黙って諦める。** プロンプト側に手で投稿する経路が残っている

**この形はClaude Codeの内部仕様に依存する**（Remote ControlのURLを`~/.claude/sessions/`から
引いているのと同じ性質）。壊れても計画が自動で載らなくなるだけで、セッションは止まらない。

### 「ラベルを外してよいか」の印はホスト側に置く

`00.check-user`を外すのは**自分で付けたときだけ**にする必要がある。`Stop`はturnごとに飛ぶため、
無条件に外すと人が別の理由で付けた`00.check-user`まで落とすからである。

その印をissue-deckのDB（`DispatchSession`）ではなくホスト側の状態ファイル
（`<セッション名>.check-user`。#1256の仕組み）へ置いているのは、**`/activity`が`ALIVE`の行が
無ければ何もしない**ため。pollerが1巡する前に計画が出ると記録できず、ラベルだけ付いて外れなくなる。

**印の名前は#1417で`.plan`から`.check-user`へ変えた**（計画の提示以外でも同じ印を使うように
なったため）。読む側は**旧名の`.plan`も見る**（#1456）。1つのセッションの中で新旧のスクリプトが
混ざる経路（後述の`.claude/settings.json`）ができたため、書いた側と読む側で名前が食い違うと
「承認しても外れない」がそのまま再現する。書くのは新しい名前だけで、消すときは両方消す。

計画待ちのまま畳まれたセッションでは、`cleanup`が印ごと消すのでラベルは残る。**これは正しい側の
取りこぼし**で、人がまだ計画を見ていないことを表す。起こし直せば新しい計画が投稿され、
その`Stop`で外れる。

なお人が画面の承認ボタンで先に外していることもあるが、`removeIssueLabel`が404を成功として
扱うのでそのまま通る。

## Claude CodeとCodexからの質問にも画面から答える（#2189・#2579）

**`AskUserQuestion`の選択肢は、端末とRemote Controlからしか選べなかった。** 画面に出るのは
「入力を待っています」というバッジと「Remote Controlから答えてください」という案内だけで、
スマホから選択肢を1つ選ぶためにTUIを開く必要があった。計画の承認（#2061）と同じ作りを
質問へ広げ、**待っている中身が「1本のテキスト」から「選択肢つきの質問」に変わったもの**として
扱う。

```text
AskUserQuestion（質問）
  → PreToolUse フック → session-notify.sh
       → POST /api/dispatch/sessions/question
            → 回答待ち（SessionQuestionRequest）を作り、そのidを返す
            → 00.check-user ＋ 01.check-input を付与（requestSessionCheckUser）
       → ホストに「ラベルを付けた」印を残す（<セッション名>.check-user）
            → （↑と同じ往復で 00.check-user が付く＝Push通知が鳴る）
       → GET /api/dispatch/sessions/question/decision?id=… を3秒おきに引いて待つ
  → 人がissue-deckの画面で選択肢を選んで「回答を送る」を押す
       → POST /api/dispatch/question-answer
            → 選んだラベルをDBの質問と突き合わせ、回答（質問文 → 回答文字列）を保存
            → 質問と回答を1件のIssueコメントとして残す
       → フックが allow＋updatedInput.answers を返す（＝選択フォームは出ない）
  → ツールはその answers をそのまま結果にする → 作業の続きへ
       → PostToolUse → POST /api/dispatch/sessions/activity → 00.check-user を除去
```

Codexには`AskUserQuestion`とそのフックが無いため、#2579では同じAPIを
`scripts/submit-question.sh <質問JSONファイル>`から呼ぶ。質問ファイルは上と同じ`questions`配列で、
画面・ラベル・Issueコメント・保存する状態はClaude Code経路と共通になる。回答はanswers JSONとして
標準出力へ返し、エージェントがその内容を読んで作業を続ける。期限切れ・通信失敗は非0で止め、
回答されていないのに作業を進めない。

**Claude Code経路では、回答が決まらなければ何も返さず、従来どおりの経路へ倒れる**（待ち時間切れ／
「端末で答える」／issue-deckが応答しない）。Codex経路は未回答を成功にせず、終了コード`2`または
`3`で端末からの確認へ切り替える。60秒の通信猶予・待ちを畳ませる`POST`は計画と同じ作りで、
境界は`scripts/session-notify-question.test.mjs`と`scripts/submit-question.test.mjs`が固定している。

- **回答は`allow`＋`updatedInput.answers`で渡す。** `AskUserQuestion`は入力に`answers`
  （質問文 → 回答文字列。複数選択は`, `区切り）が入っていればそれをそのまま結果にするツールで、
  フックが`updatedInput`を返したときだけ「許可が下りていても人へ聞き直す」挙動
  （`requiresUserInteraction`）が省かれる。**#2121で計画について確かめたのと同じ仕組み**で、
  Claude Code 2.1.241のバイナリで`AskUserQuestion`にも当てはまることを確認した
  （抑止の条件はツールがMCP由来でないことだけ）。**公開仕様ではない**ので、変わっても端末に
  従来どおりの選択フォームが出るだけでセッションは詰まらない
- **質問（`questions`）は受け取ったままを添える。** `updatedInput`はツールのスキーマ検証を
  通るため、質問を作り変えると回答ごと`deny`になる。画面から届いたラベルも**DBに保存した
  質問と突き合わせてから**回答に載せる（`buildSessionQuestionAnswers`）——ここが緩むと、
  質問に無い文字列がそのままツール入力へ入る
- **Issueコメントは、答えたときに1件だけ書く。** 質問が出た時点では書かない——聞かれただけで
  答えていないものがIssueに増えると、後から読む人には何が決まったのか分からない。
  代わりに`00.check-user`＋`01.check-input`で「人を待っている」ことだけを残す
- **ラベルの付与は待ちを作れたかどうかと切り離す。** 質問が出た＝人を待っているのは確かで、
  画面から答えられるかどうかとは別の事実。紐付けると、画面にも一覧にも「待っている」ことが
  出ないIssueができる（#2108で計画について学んだのと同じ）
- **待ち時間は計画と別の環境変数で、既定も短い**（`SESSION_QUESTION_WAIT_SECONDS`。既定5分。
  計画は30分）。`ExitPlanMode`は1セッションに1回の関門だが、**質問はturnの途中で何度も起きる
  常用経路**で、待っている間は端末で答える手段が実質的に無い（`Esc`はturnごと打ち切る。上記）。
  短くして失うのは「気づくのが遅れたときにパネルではなくRemote Controlで答えることになる」
  だけで、それは#2189より前の状態と同じ。スマホから答えることが多いホストでは長くしてよい。
  **引く間隔と降りるまでの猶予は計画と共有する**（`SESSION_PLAN_POLL_INTERVAL_SECONDS`・
  `SESSION_PLAN_POLL_GRACE_SECONDS`）——どちらも「issue-deckへ何秒おきに引き、届かない状態が
  何秒続いたら降りるか」という同じ性質の値で、分けても片方だけ調整する理由が無い
- **フックのmatcherは`ExitPlanMode|AskUserQuestion`**（`scripts/run-issue-session.sh`）。
  タイムアウトも両方に掛ける——片方だけに付けると、付いていない方は既定の10分で打ち切られ、
  画面から答えられる時間が縮む
- **効くのはissue-deckのセッションだけではない。** フック設定を書く`run-issue-session.sh`は
  `generic-start-issue.sh`（他リポジトリのローカルセッション）と`start-cross-repo-question.sh`
  （横断質問セッション）からも呼ばれる。どちらもissue-deckが見ているIssueから起動するので
  パネルは出るが、**issue-deckに無いIssueで質問すると待ち時間ぶん誰も答えられない**
  （待ち切れば端末のフォームへ倒れる）。既定を5分にしてあるのはここの上限でもある
- **質問の中身はPush通知に載せない。** 通知はIssueの識別と「確認待ち」であることだけを出し、
  中身は開いてから読ませる（計画本文を通知に載せないのと同じ理由）
- **パネルはPC版・スマホ版の両方の詳細に置く**（置き忘れは`plan-approval-mount.test.ts`が
  捕まえる）。押した結果は`request.id`と対で持ち、詳細側も`key={questionRequest.id}`で
  作り直す（#2158と同じ理由）
- **画面の案内は質問を計画より先に見る。** 計画を出したあとに質問することはあり、そのとき
  待たれているのは新しい方（質問）になる（`check-user-guidance.ts`・`local-session-notice.tsx`）
- サーバー側は`src/lib/dispatch/session-question-request.ts`（値の検証・表示の判定）と
  `src/lib/dispatch/question-requests.ts`（DB）。画面は`question-answer-panel.tsx`、
  一覧の導線は`issue-list.tsx`

## 受付と締めもIssueのコメントへ残す（#1119）

計画（#1342）を自動で載せるようにしても、**Issueのコメント欄だけを見て追える範囲はActionsに
届いていなかった**。無人実行のコメントと突き合わせると穴は2つある。

| Actionsのコメント | ローカルの状況 |
| --- | --- |
| 受付コメント（モード判定の直後・`guide`。#75） | **無かった。** 起動からエージェントの最初の投稿まで、画面には何も出ない |
| 計画コメント | ✅ `ExitPlanMode`のフック（#1342・`session-plan.ts`） |
| 完了報告コメント | プロンプトの「Issueに残す記録」に**項目自体が無かった**（計画・判断・中断だけ） |
| PR作成／developへのマージ | ✅ `issue-labels.yml`。GitHub側のイベントで動くので経路が同じ |
| 失敗時のフォールバック通知 | 異常終了だけ ✅（#1217・`session-escalation.ts`）。**正常に終わって何も投稿しなかった場合**は拾えない |

埋め方は3つで、どれも投稿するのはissue-deck（GitHub App名義）。**サブPCにGitHubの認証を
持たせない**ための一本化は#1342と同じ。

```text
run-issue-session.sh（claudeの起動直前）
  → POST /api/dispatch/sessions/started → 受付コメント（session-start.ts）
… セッション …
run-issue-session.sh の cleanup（trap） → POST /api/dispatch/sessions/ended
poller の巡回（trapを通らなかった場合）  → POST /api/dispatch/sessions
  → どちらも markDispatchSessionEnded / reportDispatchSessions
     → 記録が何も無ければ締めコメント（session-wrapup.ts）
```

### 受付をエージェントに任せない

**Actions側が受付を独立したシェルステップに置いているのと同じ理由**（#75）。エージェント自身に
委ねると、調査に時間がかかった場合や途中で行き詰まった場合に「依頼を受け取ったこと」自体が
伝わらない。ローカルではさらに、Actions UIに相当する実行ログが無いぶん「押したのに何も
起きていない」と区別が付かない。そのため受付コメントには`tmux attach -t <セッション名>`を必ず
載せ、様子を見に行ける先を最初の1件で渡す。

- 役割の表示は`guide`（案内ボット）で、Actionsの受付と揃える（#860）。受付はモードによらず
  案内であって、実装作業そのものの報告ではない
- **重複は抑止しない。** 1起動につき1件で、Actionsもdispatchのたびに受付を出すので挙動が揃う。
  同じIssueで起こし直したことがコメントの並びから分かる方が、追う側にとって都合がよい
- 投げるのは`claude`の**起動直前**。`claude`はフォアグラウンドで走るので、それより後ろに置くと
  セッションが終わるまで投稿されない

### 締めコメントは「記録が1件も無いとき」だけ

完了報告はプロンプトの指示、つまりエージェントが従うかどうかに依存していて担保が無い（#1342で
計画に同じ問題があったのと同じ構図）。そこでセッションが消えた時点でIssueを見に行き、
そのセッションの間に何も残っていなければ締めのコメントを書く。

- **`00.check-user`は付けない。** ローカルは人が横にいる前提で、意図的に畳んだだけで要確認バッジが
  立つのは過剰。人の判断が要る異常終了は#1217が`00.check-user`込みで拾うので穴にはならない
- **重複はDBの列ではなくマーカーで防ぐ。** 呼び出し経路が`trap`（`/sessions/ended`）とpollerの
  巡回の2つあり、どちらも同じセッションについて呼びうる。`session-wrapup.ts`は**自分の
  `<!-- issue-deck:session-wrapup -->`も「記録あり」に数える**ので、2回目は投稿しない。
  `DispatchSession`へ列を足せば済む話ではあるが、マイグレーションは`CLAUDE.md`の自動マージ
  不可カテゴリなので、足さずに済む形を選んだ
- **基準時刻は受付コメントの投稿時刻**で、`DispatchSession.firstSeenAt`はその代替に留める。
  `firstSeenAt`はpollerが最初に見た時刻で、起動から最大1巡（既定60秒）遅れる。その差の間に
  計画が出ると「記録なし」と誤判定する
- 数えるのはマーカーを持つコメントだけで、**人が書いたコメントは数えない**。ここで見たいのは
  セッションが何をしたかで、`11.local`が付いている間、人のコメントはそもそもセッションに
  届かない（#1287）

### プロンプト側にも完了報告を書く

自動化は「何も残らなかった」を検出するだけで、中身のある完了報告の代わりにはならない。
`scripts/prompts/implementation-agent.md`・`generic-implementation-agent.md`の「Issueに残す記録」に
**完了報告**（PRのURL・変更の要約・テスト内容）を必須項目として足してある。粒度は無人実行の
`.github/prompts/implement.md`に揃えた。あわせて「着手した旨は投稿しない」（受付が自動で出るため）
も書いてある。

**文面を変えたら`node scripts/generate-prompt-templates.mjs`を実行する**
（`src/lib/prompts/templates.generated.ts`。ずれは`src/lib/prompts/templates.test.ts`が検出する）。

## 扱うイベント

`--permission-mode auto`（#1205）により承認プロンプトは激減しているので、報告するのは
**「本当に人の判断が要るもの」と「完了」**に絞る。判定は
[scripts/session-notify.sh](../../scripts/session-notify.sh)が持つ。

| フック | 条件 | 意味 | issue-deckへ |
| --- | --- | --- | --- |
| `Notification` | `notification_type` が `permission_prompt` | 承認プロンプト・`AskUserQuestion`の質問 | 様子（`waiting_input`）＋`00.check-user`（＝Push通知） |
| `Notification` | `notification_type` が `idle_prompt` | 応答終了から60秒アイドル | **送らない** |
| `Stop` | — | 応答の終了。無人で回すセッションでは実質「作業完了」 | 様子（`responded`）＋`00.check-user`を解く保険 |
| `PreToolUse` | `tool_name` が `ExitPlanMode` | 計画の提示（#1342） | 計画を送り、画面の返事を待つ |
| `PreToolUse` | `tool_name` が `AskUserQuestion` | 質問（#2189） | 質問を送り、画面の回答を待つ |
| `PostToolUse` | 状態ファイルの最後のイベントが `permission_prompt` | 人が答えて作業へ戻った（#1357） | 様子（`working`）＋`00.check-user`を解く |
| `PostToolUse` | `tool_name` が `Artifact`（公開のとき） | アーティファクトを公開した（#2154） | HTMLの原本を送る（後述） |
| `SessionStart` | — | Claude Codeが開始した（#1465） | **送らない**（ホスト側の印を消すだけ。後述。Codexではここで`codex queue`の宛先を残し、スレッドに`<リポジトリ名> #<Issue番号>`の名前を付ける。#2519・#2540） |
| （フックではない） | pollerが合成する `SessionInterrupted` | APIエラーで中断（#1971）／ツール呼び出しが実行されないまま停滞（#2655） | Issueコメント＋`00.check-user`＋`01.check-blocked`（#2280。後述） |

**`idle_prompt`を捨てるのは、直前の`Stop`と必ず二重になるため。** 応答が終わって60秒
放置されると発火するので、`Stop`を報告した約60秒後に同じ内容がもう1件飛ぶことになる。

`--permission-mode auto`でも`AskUserQuestion`では`permission_prompt`が発火する（実測）。
autoは「Claudeが自分で判断してよいもの」を自動承認するだけで、人に聞く意思そのものは
潰さないため、この経路は生きている。

`SessionEnd`は使っていない。tmuxのウィンドウを閉じただけのイベントに報告の価値が薄い。

**Codex CLIで起こしたセッションからも、同じスクリプトが呼ばれる**（#2509）。イベント名も
フィールド名（`hook_event_name`・`tool_name`・`tool_input`）もClaude Codeと同じなので読み替えは
無いが、**届くのは`SessionStart`と`Stop`の2つだけ**で、`session-notify.sh`にCodex用の分岐は無い
（来ないイベントは既存の判定がそのまま`skip`にする）。残りが来ない理由と、`--ask-for-approval never`の
Codexでは**このスクリプトが`00.check-user`を付けることが無い**ことは[codex.md](codex.md)を参照。

**`SessionInterrupted`だけはフックではない**（#1971）。APIエラー（529等）でturnが打ち切られると
Claude Codeは`Stop`を飛ばさないため、pollerが自動再開を上限まで試したあとに同じ形のJSONを
合成して`session-notify.sh`へ渡す。**#2280より前はSignalyへ通知するだけだった**が、通知先が
無くなったので専用の受け口（`POST /api/dispatch/sessions/interrupted`）へ送り、**異常終了
（#1217）・起動確認での足止め（#1465）と同じ形**——Issueコメント＋`00.check-user`＋
`01.check-blocked`——で引き上げる（文面は`src/lib/dispatch/session-escalation.ts`）。

- **様子の受け口（`/activity`）へは相乗りさせない。** 中断は「今このセッションが何をしているか」
  を言えない（`working`のまま止まっている、が最後に分かっている事実）。ラベルだけを立てて通す
  こともできるが、それだと**何が起きたのかがIssueに残らず、理由ラベルも`01.check-input`になる**
- **理由は`01.check-blocked`。** ユーザーがやることは「回答」ではなく**続け方の指示**
  （[labels.md](labels.md)の理由ラベルの定義）
- **`00.check-user`の印（`<セッション名>.check-user`）は置かない。** 置くとセッションが動き出した
  `Stop`でラベルが外れるが、人がまだ続け方を指示していないことがある。外すのは人の操作に任せる
- 境界は`scripts/session-notify-activity.test.mjs`と
  `src/lib/dispatch/session-escalation.test.ts`が固定している

### ツールを呼び出したつもりでテキストに書いただけで、実際には呼ばれていないまま止まることがある（#2655）

**`Stop`が正常に発火していても、実質何も進んでいないことがある。** サブPCのキックオフ直後
（Issueの実装を始めた最初のターン）で、Claude Codeが`Agent`ツール（大きな実装をforkへ委任する）を
呼び出すつもりが、実際にはtool_useとして呼び出さず`Agent({ subagent_type: "fork", ... })`という
**コード風のテキスト**を出力するだけで`stop_reason: end_turn`となりターンを終える、という誤動作を
実地の転記（`~/.claude/projects/<スラッグ>/<セッションID>.jsonl`）で確認した。直近3日で調べた
キックオフ4件全て（研究デスク#41・issue-deck#2646・#2653・aide#226）で同じ現象が起きており、
再現性が高い。

このターン終了でも`Stop`フックは正常に発火するため、上の`SessionInterrupted`（#1971）が対象にする
「`Stop`が飛ばないAPIエラー」とは別の現象で、既存の自動再開の対象外になる。issue-deck側からは
「正常に応答した」ように見えたまま、セッションが放置される。

- **判定は`scripts/lib/session-tool-call-stall.sh`が持つ。** 転記の最後のやり取りが
  `assistant`のテキストのみ（`tool_use`を含まない）で、既知のツール名＋`({`という記法を含み、
  かつ一定時間（既定15分）転記が更新されていない場合に検知する
- **自動での指示再送信はしない。** 研究デスク#41の実例で、「進めて」という再送信のあとも
  モデルが「自分は先にツールを呼び出した」という誤った過去発言を事実と誤認し、`ListAgents`で
  確認しても見つからないのに「まだバックグラウンドで動いている」と誤答して再び止まったことを
  確認しており、固定文言の再送信では確実な復旧にならない（#1971の自動再開とはここが違う）
- **既存の`/api/dispatch/sessions/interrupted`をそのまま使う。** pollerが送るJSONに
  `interrupt_reason: "tool_call_stall"`を足し、`session-escalation.ts`側が原因ごとに
  Issueコメントの文言（原因の説明部分だけ）を出し分ける。ホスト・tmuxセッション・出口
  （`tmux attach`・Remote Control・`00.check-user`が自動で外れない旨）の構造は共通
- 停滞時間の判定は`lib/session-resume.sh`の`session_resume_stalled_seconds`をそのまま使う
  （転記のmtimeからの経過秒数という同じ性質のため）。APIエラー検知（既定10分）より長い
  既定15分にしてあるのは、実際にAgent(fork)が起動できていて単に時間がかかっているだけの
  正常なケースを早すぎる段階で誤検知しないため
- 境界は`scripts/session-tool-call-stall.test.mjs`が固定している

## 公開したアーティファクトはissue-deckへ取り込む（#2154）

**claude.aiのアーティファクトページはiframeに入らない。** `https://claude.ai/code/artifact/<id>`は
`content-security-policy: frame-ancestors 'self'`を返すため（実測）、URLだけを画面へ運んでも
「ブラウザに遷移せずにアプリ上で見る」ことにはならない。中身を出している
`<id>.frame.claudeusercontent.com`の方も、トークン付きのパスでしか開かない。

そこで`Artifact`ツールの`PostToolUse`で、**公開したHTMLファイルの原本ごと**
`POST /api/dispatch/sessions/artifact`へ送る。issue-deckは`uploads/artifacts/`へ保存し、
自分のオリジンから`GET /api/issues/artifacts/<id>`として配り直す。

- **`PostToolUse`の間引き（#1357）より前で処理する。** 間引きは「直前が入力待ちのとき」しか
  通さないが、アーティファクトの公開の直前に承認プロンプトが出るとは限らない
- **公開（`action`が未指定か`publish`）だけを拾う。** `list`・`read`・`comments`・`upload_asset`は
  取り込まない
- **URLはツールの応答から正規表現で拾うだけ**で、取れなくても取り込む。見た目を出すのに
  要るのはHTMLの原本で、URLはclaude.aiで開き直すための逃げ道にすぎない
- **同じファイルパスへの再公開は上書き**（claude.aiでも同じURLになる）。履歴は持たない
- 出るのは**近似**。claude.aiが公開時に足しているmermaidの描画とランタイム機能
  （`window.claude.*`）は再現しない。その断りは画面（プレビューの下辺）に出している
- 中身はエージェントが書いた任意のHTML・JSなので、**配信時のCSPと画面のiframeの両方で
  `sandbox`し、`allow-same-origin`は付けない**（付けるとissue-deckのCookie・localStorageへ
  手が届く）

### 計画の承認前は、計画ファイル経由で差し替える（#2200）

**Plan modeで書けるのは計画ファイルだけ**（Claude Code 2.1.241のplan modeリマインダに
`Read-only except plan file (…)`とあり、プロトタイプの案内も「the prototype is built after plan
mode ends, never during it」と言う）。そのため計画の承認を待っている間は、上の`Artifact`ツール
経由の経路が使えない——HTMLファイルを書けないので公開し直せない。#1745・#2110では
「Plan modeの中では差し替えず、承認後に同じパスで再公開する」手順で凌いでいたが、
**承認するまで新しい見た目を見られない**ままだった。

そこで**書ける唯一のファイルである計画ファイルの中にHTMLを置く**。`ExitPlanMode`の
`PreToolUse`フックは計画ファイルの中身をそのまま送ってくるので、
`POST /api/dispatch/sessions/plan`が受け取った本文からHTMLを切り出し、`Artifact`ツール経由と
**同じ`saveSessionArtifact`**へ渡す（`src/lib/dispatch/plan-artifact.ts`）。

```text
画面の「修正を送る」（アーティファクトの直し）
  → フックが deny＋本文を返す → Claudeが計画ファイルのHTMLを書き換える
  → ExitPlanMode → POST /api/dispatch/sessions/plan
       → 計画本文からHTMLを切り出す（残りが計画コメントになる）
       → saveSessionArtifact（同じ sourcePath なら同じカードを上書き）
  → 画面のカードが新しい見た目に差し替わる → 承認
```

- **Plan modeの制約は破っていない。** 書き込みを通すフックも、権限の拡大も足していない。
  エージェントが書き換えるのは計画ファイルだけ
- 合図は**バッククォート3つ以上＋`artifact`**のフェンス。`html`にしないのは、計画に説明用の
  HTML片が入ることがあり、巻き添えで取り込むため
- 差し替え先は直前の`<!-- artifact: <パス> -->`で決める。**`Artifact`ツールで公開したときと
  同じパス**を書いてもらうことで、カードが2枚に増えない。無い場合は
  `plan-artifact:<repo>#<番号>`という実在しないキーへ落とす
- **長さを見るより前に切り出す。** HTMLが載ったままだと計画本文の上限に掛かり、
  計画そのものがIssueへ残らなくなる。切り出しに外れた場合（フェンスが閉じていないなど）も
  諦めずに投稿できるよう、受け取りの上限は埋め込むHTMLと同じ2MBまで引き上げてある
- **計画のPOSTは標準入力から渡す**（`post_to_issue_deck_capture`）。`-d "$body"`のままだと
  数百KBの本文が`ps`の出力にもargvの上限にも掛かり、送信ごと落ちる＝`planRequestId`が返らず、
  **計画コメントも承認パネルも出ない**。アーティファクトの送出が先に同じ理由で
  `--data-binary @-`になっていた
- **閉じていないフェンス・空・上限超過は触らない**（計画本文をそのまま通す）。この機能が
  効かないことより、計画が残らないことの方が損失が大きい
- 取り込めた回だけ、計画コメントの冒頭に「アーティファクトも更新しました」の1行が入る

画面では、Issue詳細の「アーティファクト」カードと、本文・コメント中のclaude.aiリンク
（保存済みのものだけ）から開ける。**カードは畳めるセクションではなく常時表示**（#2190）で、
`25.artifact-required`のIssueではこれ自体が承認の対象——畳まれていると開くまでどの案かが
分からない。各行のサムネイルも同じ配信URLをiframeで縮小したもの（新しい方から6件まで）。

## 報告の中身

`POST /api/dispatch/sessions/activity`へ載せるのは、リポジトリ・Issue番号・様子（`activity`）・
Remote ControlのURL（取れたときだけ）・`00.check-user`を付けるか外すかだけ。開発環境のURL
（#1265。`23.preview-required`のセッションで`tailscale serve`が通っているとき）は、セッションの
起動時に`run-issue-session.sh`が同じ受け口へ別途送る。

**応答テキスト（`Stop`フックの`last_assistant_message`）・計画本文・質問の選択肢は、Push通知に
載せない。** 応答本文にはIssue本文の引用・ファイルの中身・コマンドの出力が混ざりうる。
通知に出すのはIssueの識別と「確認待ちである」ことだけにして、中身は開いてから読ませる
（`buildCheckUserPushPayload`）。計画と質問の中身はissue-deckのDBには保存され、画面のパネルに出る。

## セットアップ

**#2280より前はSignalyのwebhook URLの登録が要ったが、今は不要。** 必要なのはissue-deckへの
報告先だけで、それはディスパッチpollerと同じ`~/.config/issue-deck/dispatch.env`
（`APP_BASE_URL`・`DISPATCH_SECRET`）から読む。

1. 待ち時間を既定から変えたいときだけ、`deploy/subpc/notify.env.example`を
   `~/.config/issue-deck/notify.env`へ置いて編集する（**chmod 600**）。無くても動く

   ```bash
   install -D -m 600 deploy/subpc/notify.env.example ~/.config/issue-deck/notify.env
   ```

2. Push通知を受け取る端末で、issue-deckの設定＞通知から購読を1回登録する
   （`src/components/dashboard/settings/notification-settings-section.tsx`）
3. フックの設定は`run-issue-session.sh`が起動のたびに生成する（`PostToolUse`だけは
   リポジトリの`.claude/settings.json`にも入っている。#1456）ので、他にやることは無い

**`dispatch.env`を設定していないPCでは、`session-notify.sh`は黙って何もしない。** メインPCで
同じリポジトリのセッションを起動しても画面には出ない。

**#2280より前に設定したホストには不要な残骸がある。** `~/.config/issue-deck/notify.env`の
`SESSION_NOTIFY_WEBHOOK_URL`と、1Passwordの`apps/issue-deck/session-webhook-url`。読む側が
無くなったので消してよい（放置しても害は無いため、掃除のためのIssueは立てていない）。

## 設定したら1回手で発火させる

`session-notify.sh`はフックから呼ばれる限り**何が起きても`exit 0`で返す**（後述）。
つまり**設定が壊れていても、セッション側には何の兆候も出ない。** 気づける唯一の機会が、
手で叩いたときのstderrなので、設定・変更のたびに1回実行する。

```bash
printf '{"hook_event_name":"Stop","session_id":"manual-test"}' \
  | scripts/session-notify.sh 1231 issue-deck guchi-apps/issue-deck
```

- 成功: 標準出力・標準エラーには何も出ない。issue-deckのIssue詳細に「応答を終えました」が出る
- 失敗: `session-notify: issue-deckへの様子の報告に失敗しました（実装は続行します）` が
  stderrに出る。`dispatch.env`の`APP_BASE_URL`・`DISPATCH_SECRET`が誤っているか、
  issue-deckが落ちている

`SESSION_NOTIFY_DRY_RUN=1`を付けると送信せず、宛先とpayloadだけを出力する。**これは組み立て
までしか見ておらず、宛先が正しいかは検証されない。** 届くことの確認には必ず実際に発火させる。

## フックはこのスクリプトから起動したセッションにだけ適用する

`~/.claude/settings.json`（ユーザー設定）に書くと、メインPCの対話セッションでも通知が飛んで
邪魔になる。そこで[scripts/run-issue-session.sh](../../scripts/run-issue-session.sh)が
`$ISSUE_DECK_WORKTREE_BASE/.claude-hooks/issue-<番号>.settings.json`を生成し、
`--settings`で渡す。`--settings`の内容はユーザー設定・プロジェクト設定に**加算**されるので、
既存の設定を壊さない。

JSON文字列ではなくファイルで渡すのは、`ps`の出力にフックの中身が丸ごと出るのを避けるため
（プロンプトをファイル経由で渡しているのと同じ理由。#1105）。

フック設定に書くのは「`session-notify.sh`を呼ぶ」ことだけで、どのイベントを送るかの判定は
スクリプト側に置いている。判定を2箇所に分けると、必ずどちらかが古くなる。

**Codexでは`--settings`に当たるものが無いので、`-c 'hooks.<イベント>=…'`のオーバーライドで
渡す**（#2509）。ファイル（`~/.codex/hooks.json`はホスト全体、`<worktree>/.codex/hooks.json`は
リポジトリの中）に置くとこの節の狙い——**このスクリプトから起こしたセッションにだけ効かせる**——が
崩れるため、プロセスに閉じる`-c`を選んでいる。`ps`に出るのは`session-notify.sh`のパスと
Issue番号・リポジトリ名だけ（[codex.md](codex.md)）。

## セッション側のスクリプトは`origin/develop`の同期コピーから走らせる（#1274・#1438）

**フックが呼ぶ`session-notify.sh`は、worktreeのコピーではない。** 生成されるフック設定の
`command`は絶対パスで、`run-issue-session.sh`自身の置き場所（`$SCRIPT_DIR`）を指す。
つまり「`run-issue-session.sh`をどこから呼んだか」が、そのセッションのフックの版を決める。

もともとは本体リポジトリの作業ツリー（`~/apps/issue-deck/scripts/`）から呼んでいて、そこに
**worktreeだけが新しくなる**という非対称があった。`start-issue.sh`は起動のたびに
`git fetch origin develop`してからworktreeを作るが、「本体の作業ツリーには一切触れない」ことを
約束しているのでmergeはしない。**本体の作業ツリーを新しくするのは人の`git pull`だけ。**

そのため`session-notify.sh`をdevelopへマージしても、pullするまで実際の挙動は古いままになる。
#1274はこれを踏んだもので、#1247でリンク書式を直した数時間後の通知が、依然として旧書式
（`Links`フィールドに生URL）で届いていた。#1438も同じで、承認と同時に`00.check-user`を外す
仕組み（#1357・#1417）を入れた後も、古い作業ツリーのホストでは**`PostToolUse`のフック設定
そのものが生成されず**、承認しても応答終了（`Stop`）まで外れなかった。
**スクリプト側には何の兆候も出ない**ため、直したはずの不具合を再度Issueとして起票することになる。

そこで#1438から、**セッションと一緒に動くものだけは`origin/develop`から取り出した同期コピー
（`~/.cache/issue-deck/launcher-scripts/<SHA>/scripts/`）を走らせる**
（[scripts/lib/launcher-scripts-sync.sh](../../scripts/lib/launcher-scripts-sync.sh)の
`resolve_launcher_scripts_dir`）。作業ツリーには一切触れないまま、フックの中身だけが新しくなる。

| 実行されるもの | どこから |
| --- | --- |
| `start-issue.sh`・`generic-start-issue.sh` | 本体の作業ツリー（人が叩く入口なので、ここは変えられない） |
| `start-cross-repo-question.sh` | 同期コピー（自分自身を実行し直す。#1583。作れなかった場合は本体の作業ツリー） |
| `run-issue-session.sh` | 同期コピー（作れなかった場合は本体の作業ツリー） |
| `session-notify.sh`・`scripts/lib/` | 同上（`run-issue-session.sh`が自分の`$SCRIPT_DIR`から読むため自動で揃う） |
| プロンプトのひな形（`scripts/prompts/`） | 同上（セッションへそのまま渡るものなので同じ扱い） |
| サブPCのpoller（`subpc-dispatch-poller.sh`） | 本体の作業ツリー（systemdが起動する常駐プロセス） |
| `PostToolUse`のフック（#1456） | **worktree**（`.claude/settings.json`。次節） |
| 実装対象のコード | worktree（`origin/develop`から作られる） |

**同期コピーを使うのは「本体の作業ツリーが単に古いだけ」と確かめられたときに限る。**
`scripts/`に未コミットの変更があるか、HEADが**どのリモート追跡ブランチにも含まれていない**
（＝手元にしか無いコミットがある）場合は、これまでどおり作業ツリーのものを走らせる。**起動
スクリプトが、人が今書いているものを黙って無かったことにしてはいけない。** gitが無い・fetchできない・
展開に失敗したといった場合もすべて作業ツリーに落ちる（起動を止める理由にはしない）。

**判定を「HEADが`origin/develop`の祖先か」にしない**（#1583）。本体チェックアウトはリリース作業
などで`main`に乗ることがあり、`main`のマージコミットは`develop`に含まれない。そのため元の条件では
**発行済みのブランチに乗っているだけで同期コピーが丸ごと無効化**され、しかも何も出ないため
気付けなかった（サブPCは`main`（v4.0.0）に乗ったまま67コミット遅れており、#1438を入れた後も
セッション側のスクリプトとプロンプトは古いままだった）。リモートへ出ているコミットなら、そこへ
戻れなくなるものは無い。

古いコピーは30日触られていないものだけを消す。**走っているセッションのフックはそのコピーを
何時間も読み続ける**ため、使用中のものを消さないことを優先する。

作業ツリーが`origin/develop`と違うこと自体は引き続き警告する（#1274・#1426。`start-issue.sh`と
`run-issue-session.sh`の両方から呼び、後者はtmuxのpaneに確実に出す）。**入口のスクリプトと
pollerは作業ツリーのままなので、警告が要らなくなったわけではない。**
`ISSUE_DECK_SKIP_SCRIPTS_SYNC_CHECK=1`を付けると、警告も同期コピーも止まる（手元のものを
そのまま走らせたいときの逃げ道）。

## `PostToolUse`だけはworktree側の`.claude/settings.json`にも置く（#1456）

前節の同期コピー（#1445）には、**それ自体が本体の作業ツリーにあるという穴が残っていた。**
同期するかどうかを決める`scripts/lib/launcher-scripts-sync.sh`は`~/apps/issue-deck/scripts/`から
読まれるので、**そこが古い間は同期の仕組みごと存在しない。** つまり「1度pullするまで効かない」
（#1446）。実際、#1445をdevelopへマージした後もサブPCでは`PostToolUse`のフック設定が生成されず、
計画を承認しても`00.check-user`が応答終了（`Stop`）まで外れないままだった（#1456）。

**`.claude/settings.json`はリポジトリに入っていて、worktreeは毎回`origin/develop`から作られる。**
ここに置いたフックだけは、本体の作業ツリーの新しさに一切依存しない。**developへマージした時点で
次のセッションから効く。**

```text
.claude/settings.json（worktree＝常に新しい）
  → PostToolUse → scripts/session-notify-hook.sh（worktreeのもの）
       → scripts/session-notify.sh（worktreeのもの）
```

- **足すのは`PostToolUse`だけ。** `Notification`・`Stop`・`PreToolUse`は古い作業ツリーでも
  生成されるので、ここに置くと**同じ入力待ちがissue-deckへ二重に飛ぶ**。`PostToolUse`は
  古いホストでは生成されない（＝二重にならない）一方、新しいホストでは二重になるが、
  `session-notify.sh`が「状態ファイルの最後のイベントが`permission_prompt`のとき」以外を即座に
  捨てるため、報告が飛ぶのは**入力待ち1回につき最大1回**。二重に走っても`/activity`が1回余計に
  飛ぶだけで、ラベルの除去は冪等（`removeIssueLabel`は404を成功として扱う）
- **プロジェクト設定はこのリポジトリの全セッションに掛かる。** 人が手元で開いた対話セッションや
  GitHub Actions上の無人実行まで報告を飛ばさないよう、`session-notify-hook.sh`は
  **tmuxのセッション名がランチャーの規約（`<リポジトリ名>-issue-<番号>`）に一致し、かつworktreeが
  `issue-<番号>`ブランチにあるとき**だけ先へ進む。tmuxの外（Actions）は最初の1行で落ちる
- 引数（Issue番号・リポジトリ名・`owner/repo`）は、生成されるフック設定と違って**書き込む側が
  いないので、そのworktreeとtmuxのセッション名から引く**
- **どのイベントを扱うかの判定は`session-notify.sh`のまま**で、`session-notify-hook.sh`が持つのは
  「誰のセッションか」だけ。判定を2箇所に分けない

`00.check-user`を付けたことの印は、古いホックが旧名（`<セッション名>.plan`）で書いていることが
あるため、読む側が新旧どちらも見る（前述）。

**他リポジトリ（`dayspan`等）にはこの`.claude/settings.json`が無い**ので、汎用ランチャーで
起こすセッションは従来どおり本体の作業ツリーの新しさに依存する。`run-issue-session.sh`が
`PostToolUse`を生成し続けるのはそのため。

## 報告の障害でセッションを止めない

報告経路の障害で実装が止まるのは本末転倒なので、`session-notify.sh`は**何が起きても
`exit 0`で返す**。宛先が未設定でも、`curl`が失敗しても、`python3`が無くても同じ。
`curl`には`--max-time`を掛けてあり、応答が返らないissue-deckでセッションを待たせない。

フックが非0で終了してもClaude Codeは`Failed with non-blocking status code`と表示して続行する
（実測）が、セッションのログに毎回エラーが出ると本来見たいものが読めなくなるため、
そもそも非0を返さない。なお**exit 2はフックの規約でブロッキング扱いになるので絶対に返さない**。

失敗をログに出すときも宛先と鍵は出さない。`DISPATCH_SECRET`はそれ自体が報告権限を持つ
シークレットで、tmuxのスクロールバックに残る。

## Remote Control

`claude --remote-control [name]`で、セッションをclaude.ai経由でスマホやブラウザから
操作できるようになる。`run-issue-session.sh`が`--name`と同じセッション名で付ける。

- 起動直後に `/remote-control is active · Continue here, on your phone, or at
  https://claude.ai/code/session_XXX` と表示される
- tmux上で問題なく動く。既存のログインを使うので追加のペアリング操作は要らない
- **`ISSUE_DECK_CLAUDE_REMOTE_CONTROL=0` で無効化できる。** 既定は有効
- `--remote-control`を解釈しない古いClaude Codeへ渡すと起動ごと失敗するため、
  `claude --help`に載っているときだけ付ける（`--name`と同じ扱い）

通知にURLを載せられるのは、`~/.claude/sessions/<pid>.json`に`sessionId`と`bridgeSessionId`
（`https://claude.ai/code/<bridgeSessionId>`のID）の対応があるため。フックには`session_id`が
渡ってくるので、そこから引ける。

**これはClaude Codeの非公開の内部ファイルなので、更新で形が変わりうる。** 読めなくても
通知自体は落とさず、URLだけが載らなくなる設計にしてある。

## #1179 のジョブキューとの切り分け

**この通知は`POST /api/dispatch/report`にも`POST /api/progress`にも何も足さない。**

- ディスパッチのジョブ状態（#1179）の`succeeded`は「tmuxセッションが立ち上がった」までで、
  それ以降は追わない
- 実装の進捗はProject Statusが唯一の正として持つ
  （[progress-status-architecture.md](../progress-status-architecture.md)）

## 画面にも同じ様子を渡す（#1264）

当初この節は「『入力待ち』はissue-deckのDBへ入れると、セッションが落ちたときに誰も消せない
古い状態が残る。通知として飛ばして終わらせるのが一番安い」としていた。**#1264で必要が出たので
設計し直した。**

必要になった理由は、**通知を消した時点で承認待ちであることを知る手段が無くなる**こと。
サブPCで`21.plan-required`のIssueを起こすと計画はセッション内のPlan modeで止まるが、
issue-deckの画面には何も出ず（`00.check-user`を付けるのはActions側の計画提示ステップだけ）、
唯一の合図がプッシュ通知だった。

そこで`session-notify.sh`が、状態ファイルへ記録するのと同じタイミングで
`POST /api/dispatch/sessions/activity`へも投げる（#2280でSignalyを消してからは、これが唯一の
外向きの経路）。

| 送るもの | 値 |
| --- | --- |
| `repository` / `issue` | 引数で渡っているもの |
| `activity` | `waiting_input`（`permission_prompt`）/ `working`（`PostToolUse`。#1357）/ `responded`（`Stop`） |
| `remoteControlUrl` | 取れたときだけ。受け口は**`https://claude.ai/`配下しか受け付けない** |
| `previewUrl` | セッション起動時に`run-issue-session.sh`が別途1回だけ送る（#1265）。受け口は**tailnet内（`*.ts.net`）のhttp URLしか受け付けない** |

宛先と鍵（`APP_BASE_URL`・`DISPATCH_SECRET`）はpollerと同じ`~/.config/issue-deck/dispatch.env`
から読む。**未設定でも失敗しても実装は止めない**（このスクリプトの約束）。設定していない
ホストでは通知だけが飛び、画面に出ないだけになる。

### 古い「入力待ち」が残らない担保

当初の懸念（誰も消せない古い状態が残る）は、解ける経路を4つ持たせることで潰している。
3つ目は**#1353で足りないことが分かって足した**（次節）、4つ目は**#1357**（そのあと）。

| 経路 | 何が起きるか |
| --- | --- |
| `PostToolUse`フック（#1357） | `WORKING`へ遷移する。人が承認プロンプトに答えた直後だけ飛ぶ |
| `Stop`フック | `RESPONDED`へ遷移する。応答が終われば必ず飛ぶ |
| pollerの1巡（既定60秒） | セッションが消えれば`EXITED`/`FAILED`/`GONE`になる |
| 同じ名前で立ち上がり直したときの破棄（#1353） | `activity`・`activityAt`・`remoteControlUrl`を`null`へ戻す |

**画面側は状態（poller）を様子（フック）より優先する**（`summarizeIssueSession`）。
セッションが落ちていれば、`WAITING_INPUT`の報告が残っていても「入力待ち」とは出さない。
入力を待つ相手がもういないため。

### セッションが始まる前は、フックでは何も分からない（#1465）

**初めてクローンしたリポジトリでは、`claude`の起動直後にフォルダの信頼確認
（`Is this a project you created or one you trust?`）が出て、答えるまでセッションが始まらない。**
この間はフックが1つも飛ばない（実測: 信頼確認の表示中は`SessionStart`すら飛ばず、答えた直後に
飛ぶ）。ここまでの仕組みはすべて「フックが飛ぶこと」を前提にしているため、画面には
`subpcで実行中`とだけ出たまま何も進まず、端末を見ていない人には気付く手段が無かった。

そこで**「フックが飛ばないこと自体」を計器にする**。`gates.md`の「フックが飛ぶか」という境界の
外側なので、担当するのはpollerだが、**画面（`capture-pane`）の文字列は読まない**。

| 誰が | 何をするか |
| --- | --- |
| `run-issue-session.sh` | `claude`の起動直前に印（`<セッション名>.starting`、中身は置いた時刻）を置く。**フック設定を生成できたときだけ**（消す相手がいないと出続けるため） |
| `SessionStart`フック | 印を消す。通知もissue-deckへの報告も行わない。**`session-notify.sh`はどのイベントでも印を消す**（フックが1つでも飛べばClaude Codeは開始している。`SessionStart`だけに頼ると、それが飛ばない環境で正常なセッションのたびに誤って引き上げる） |
| poller（1巡60秒） | 印が猶予（`ISSUE_DECK_CLAUDE_START_GRACE_SECONDS`。既定180秒）を過ぎて残っていれば、セッションの報告に`claudeStarting: true`を載せる |
| issue-deck | `activity`を`NOT_STARTED`にし、Issueへ「起動確認で止まっている」と投稿して`00.check-user`を付ける（`escalateNotStartedSession`） |
| issue-deck | 人が答えて印が消えれば（`claudeStarting: false`）`activity`を戻し、付けた`00.check-user`を外す（`resolveNotStartedSession`） |

- **猶予を短くしない。** 起動には数秒〜（自動更新やプラグインの同期を挟むと）もう少しかかる。
  短くすると正常な起動をIssueコメント＋`00.check-user`で騒ぐことになる。長い側の代償は
  気付くのが遅れることだけ。
- **`claudeStarting`は項目が無いことと`false`が別物。** 印を置かない古いランチャー・送らない
  古いpollerでは項目ごと来ないので、受け口はその報告で`NOT_STARTED`を解かない
  （`resolveStartingActivityTransition`）。
- **入り直しはしない。** pollerは60秒ごとに同じ報告を送るため、`NOT_STARTED`ではない行へ
  遷移するときにだけ投稿する（`shouldEscalateSession`と同じ形）。
- **画面ではRemote Controlのリンクを出さない。** セッションが始まっていない＝Remote Controlも
  繋がっていないので、案内するのは`tmux attach -t <セッション名>`だけにする。
- 信頼確認そのものは自動化しない（それを自動で承認する仕組みは、このリポジトリの外の
  ディレクトリにも同じ判断を効かせることになる）。**答えるのは人**という前提は変えず、
  気付けるようにするだけに留める。
- **起こす前に分かるなら、止まったセッションを立てない**（#1838）。ここまでは「立ってから
  気付く」仕組みで、気付くのは3分後、答えられるのは端末だけという状態が残っていた。
  `start-local-session.sh`・`generic-start-issue.sh`は起動前に`~/.claude.json`を**読んで**
  未信頼のリポジトリを見分け、worktreeを作る前に「本体チェックアウトで1回だけ答えてください」
  と出して止まる（[scripts/lib/claude-trust.sh](../../scripts/lib/claude-trust.sh)）。
  **読むだけで書き換えないので、上の取り決めはそのまま。** 判定できないとき（設定が無い・
  書式が変わった・`python3`が無い）は通す側へ倒す——誤って止めると起動できるリポジトリまで
  起こせなくなり、元の症状より重い。
- **聞かれる回数はcwdを固定して減らす**（#1529）。実装セッションのworktreeは信頼済みリポジトリの
  一部として扱われるため聞かれないが、横断質問セッションのcwdは質問Issueごとの新しい
  ディレクトリだったため毎回聞かれていた。cwdをリポジトリごとの固定名
  （`.questions/_session-<repo>`）にして、人が答えるのは初回の1回だけにしている
  （[subpc-dispatch.md](./subpc-dispatch.md)）。`~/.claude.json`は機械が書き換えない。
- **Codexでも同じ仕組みが効く**（#2509）。あちらの確認は
  `Do you trust the contents of this directory?`で、答えるまで`SessionStart`が飛ばないのも同じ。
  ただし**信頼はworktreeのパスごとに記録される**（`~/.codex/config.toml`の
  `[projects."<絶対パス>"]`）ため、Claude Codeのように「リポジトリにつき1回」では済まず、
  **Issueごとに1回聞かれる**。事前に読んで止める判定（`claude-trust.sh`）は、まだ存在しない
  worktreeのパスを見に行くことになるので置いていない——立ってから画面で気付く形になる。
  `~/.codex/config.toml`も機械が書き換えない。

### 止まっていないのに「入力を待っています」と出ていた理由（#1353）

**セッションが消えても列の値は消えていなかった。** 上の表の2つ目は「画面が状態を優先する」
だけで、`activity`の値そのものは`WAITING_INPUT`のまま行に残る。ところが`DispatchSession`の行は
`(host, tmuxSessionName)`で引き、名前は`<リポジトリ名>-issue-<番号>`とIssueごとに固定で、
消えた行も24時間残す（`GONE_SESSION_RETENTION_MS`。「さっきまで動いていた」を画面に出すため）。
つまり**同じIssueで起動し直すと前のセッションの行がそのまま再利用される**。

そのため次の順で、止まっていないセッションにオレンジのバッジが出る。

1. 入力待ちで止まっているセッションを畳む（`WAITING_INPUT`のまま`GONE`になる。**入力待ちは
   まさに畳みたくなる場面**なので、この組み合わせは珍しくない）
2. 同じIssueでセッションを起こし直す
3. pollerの次の1巡が同じ行を`ALIVE`へ戻す。`activity`は触られないので`WAITING_INPUT`が復活する
4. 新しいセッションの最初の`Stop`が飛ぶまで（＝数十分あることもある）オレンジのまま

これは`run-issue-session.sh`の`cleanup`がホスト側の状態ファイルを消しているのと同じ問題で、
理由もそのとき書いたもの（#1256「残すと、次に同じ名前で立ったセッションが前回の`Stop`を
引き継いだように見える」）と同じ。**同じ理由がDBの行にも当てはまることを見落としていた。**

対処は`reportDispatchSessions`（`isRevivedSession`）で、`ALIVE`でなくなった行が`ALIVE`へ戻る
瞬間だけ`activity`・`activityAt`・`remoteControlUrl`を捨て、`firstSeenAt`を打ち直す。
`remoteControlUrl`を一緒に捨てるのは、あれが**セッションごとに変わる**（`bridgeSessionId`）ため。
残すと「Remote Controlで開く」が死んだセッションを開く。

**`previewUrl`だけは残す。** あれはworktreeに固定のポートを指すので次のセッションでも繋がる
一方、報告は起動時の1回だけで（`run-issue-session.sh`）、その時点の行がまだ`GONE`だと
`/activity`が`ALIVE`の行しか更新しないため捨てられて二度と載らない。

**添える時刻も`activityAt`に直した。** バッジは`lastReportedAt`を出していたが、これはpollerが
1巡ごとに更新するので、**何時間前の入力待ちでも「たった今」と表示される**。復活した古い値が
古いと気づけなかったのはこれも一因。

残っている取りこぼしは1つ。「オレンジが出っぱなしになる」側に倒れる。

- **`SIGKILL`で畳んで60秒以内に起こし直した場合。** `cleanup`のtrapを通らないので
  `/sessions/ended`（#1321）が飛ばず、pollerも`ALIVE`のままを2回見るだけで、行が
  立ち上がり直したことを誰も観測できない

もう1つあった「承認プロンプトに人が答えてから、そのturnが終わる（`Stop`）まで」は、次節で
解消した。

### 答えた瞬間に入力待ちを解く（#1357）

**人が答えたことを直接知らせるフックは無い。** 飛ぶのは`Notification`（止まった時）と`Stop`
（turnが終わった時）だけなので、答えた直後に長い作業へ入ると、その間ずっと（数十分になることも
ある）オレンジの「入力を待っています」が出たままになっていた。

そこで**承認したツールが必ず走ることを手掛かりにする**。`PostToolUse`は「そのツールが動いた」
証拠で、直前が入力待ちだったなら**人がそれに答えた**ということ以外にありえない。

```text
Notification(permission_prompt) → .event = permission_prompt / 画面はオレンジ
  ↓ 人がRemote Controlかターミナルで答える（フックは飛ばない）
承認されたツールが走る → PostToolUse → .event = working / 画面は「作業中です」
  ↓ 作業
Stop → .event = Stop / 画面は「応答を終えています」
```

- **`RESPONDED`は使えない。** あれは「応答を終えています／次の指示を待っている場合があります」と
  出るので、走っている最中に送ると終わったように見える。`DispatchSessionActivity`へ`WORKING`を
  足した（＝マイグレーションを伴う。`CLAUDE.md`の自動マージ不可カテゴリ）
- **`PostToolUse`にmatcherは付けない。** 承認が要るツールは`Bash`・`Write`・`WebFetch`・
  `AskUserQuestion`・MCPのツールと広く、絞ると「答えたのに入力待ちのまま」の組み合わせが残る。
  代わりに`session-notify.sh`が**状態ファイルの最後のイベントが`permission_prompt`のとき以外を
  即座に捨てる**（python3も起こさず、HTTPも投げない）。1回報告すれば`.event`は`working`になるので、
  続くツールの実行では自然に止まる＝**入力待ち1回につき、報告は最大1回**
- **Push通知は鳴らない。** ここでやるのは`00.check-user`を外すことなので、通知が飛ぶ側には
  回らない（答えたのは人自身で、同じことを通知し返す意味も無い）
- **承認を拒否した場合は解けない。** 拒否ではツールが走らず`PostToolUse`も飛ばないため、
  従来どおり`Stop`まで待つ。拒否の直後は次の指示を待つ形で止まることが多く、実害は小さい

### 受け口はpollerの一括報告と分ける

pollerが叩く`POST /api/dispatch/sessions`は「そのホストで今見えているセッションの全て」を
前提に、含まれない行を`GONE`へ倒す。**フックの1件を同じ経路へ流すと、他のセッションが全部
消えたことになる**ため、`/activity`を別に置いている。

`/activity`は**行が無ければ何もしない**（`updated: 0`を返して200）。フックはpollerより先に
飛びうるが、行を作るとフック側が知らない`host`・`tmuxSessionName`に嘘の値が入る。1巡待てば
pollerが作るので、取りこぼしても次のフックで載る。

### 「ここへ書いても届かない」を、承認欄だけでなくコメント欄にも出す（#1287）

`11.local`が付いている間、Issueへ何を書いても無人実行は反応せず、走っているClaude Code自身にも
コメントを取りに行く仕組みは無い。#1264はこれを**承認欄**（`LocalSessionApprovalNotice`）に
出したが、**承認欄は承認待ちのときしか描かれない**。実装中に追加の指示や訂正を書く方がむしろ
多く、そちらは何の合図も無いまま埋もれる。そこでコメント入力欄にも同じ案内を置く
（`LocalSessionCommentNotice`）。

- 枠と「Remote Controlで開く」の導線は`local-session-notice.tsx`の内部コンポーネントで共有し、
  **文面だけを分ける**。片方だけ直して食い違うのを防ぐ
- 出す条件は承認欄と同じ`executionTarget.expectsActionsRun === false`。Actionsで走っている
  Issueではコメントが実際に効くので出さない
- **セッションが見つからなくても案内自体は出す。** 届かないことは`11.local`が決めており、
  セッションの記録が取れているかとは独立している。取れていないときはリンクだけが消える

### 一覧のバッジを動かす条件（#1439）

一覧の各行にある進捗バッジ（`WorkflowStepBadge`）は、6分割の横棒で進捗（Project Status）を、
**バーを掃く光**で「今動いている」ことを表す（#2516。円グラフだった頃は外周の
リングの回転だった）。**動きはGitHub Actionsの実行中にしか出ておらず、サブPCで走っている
Issueは止まって見えていた**（条件が`isRunning`＝Actionsの実行状況ポーリングだけを見ていた
ため。#1262で「サブPCのIssueはActionsのポーリングから外す」と決めた際、外した側の代わりを
用意していなかった）。

**動きの意味を「今この瞬間、エージェント側が動いている」の一点に決め、判定を
`src/lib/workflow-badge-activity.ts`の`isWorkflowBadgeSpinning`へ集約した。**

| 実行先 | 状態 | 動かす | なぜ |
| --- | --- | --- | --- |
| Actions | 実行が進行中 | ○ | 従来どおり |
| Actions | ポーリング結果が未取得・実行が無い | × | 分からないうちは動かさない |
| Actions | 起動待ち（Statusは進んでいるのに実行が無い） | × | 起動していない。文言側が「起動待ち」を出す |
| サブPC | セッションが`ALIVE`で`activity`が`WAITING_INPUT`以外 | ○ | `null`・`WORKING`・`RESPONDED`はエージェントが動いている |
| サブPC | セッションが`ALIVE`で`activity`が`WAITING_INPUT` | × | 人待ちで止まっている。文言側が「入力待ち」を出す |
| サブPC | `EXITED`/`FAILED`/`GONE` | × | 終わっている |
| サブPC | `ALIVE`だが`lastReportedAt`が5分より古い | × | pollerは60秒ごとに報告する。5分の無音はサブPC側が落ちている |
| 共通 | 承認待ち（`00.check-user`）だが、まだエージェントが動いている（#2358） | ○ | 押せる操作がまだ無い＝待っているのは処理 |
| 共通 | 承認待ち（`00.check-user`） | × | バーの左隣のアラートアイコン（人が対応する番）と矛盾する |

- **人待ちで動かさない**のがこの整理の芯。動きは一覧を流し見したとき最初に目に入るので、
  「動いていないのに動いている」を許すと合図として使えなくなる
- **`RESPONDED`（応答を終えた）も動かす側に置く。** `summarizeIssueSession`が同じものをtone
  `running`として扱っているためで、判定を割ると同じ画面の別の場所で「実行中」と「実行中でない」が
  同時に出る
- **報告の古さで止める歯止めが要る。** `GONE`へ倒すのもpollerの報告なので、サブPCごと落ちると
  行は`ALIVE`のまま残り、誰も動きを止められない
- **見た目は「バーを端から端まで掃く光」**（#2516）。円グラフだった頃は「常時見えるトラック＋
  半周の弧」の回転で表していた（#2358。それ以前の2pxの弧が1/4周だけの頃は、18pxのバッジの
  周りで回っていること自体に気付けず、スマホでは「一瞬しか出ていない」と報告された）。
  **掃く範囲を1マスの中に閉じ込めない**のはこの反省をそのまま引き継いだもので、40pxを
  端から端まで通れば動く距離は当時のリングと同等になる。常時見える輪郭の役はバー自体
  （塗り＋トラック）が果たす。**光は塗りの上を通るだけで、塗り（進捗）は動かさない。**
  実行中は塗ったマスの上を背景色寄りの光が、起動中（`QueueStepBadge`）はまだ塗りが無いので
  トラックの上を色の濃い帯が掃く
- **確認待ちでも、エージェントが動いている間は動かす**（#2358）。`00.check-user`は「人の対応が
  要る」ことしか表さず、付けた側はエージェントが止まるのを待たない。developへPRを作った直後
  （`01.check-merge`＋CI実行中）や、確認待ちのままサブPCのセッションが作業を続けている間が
  これにあたる。**判定は#2174の`selectCheckUserRunningIssueIds`をそのまま受け取る**——
  左メニュー・一覧のヘッダーが「実行中」として数えているIssueのバッジだけが止まっていると、
  同じ画面の2か所が同じIssueについて逆のことを言うことになる。計画の承認待ち・質問の回答待ちは
  あちらが先に「実行中ではない」と決める（#2238）ので、この経路でも回らない。色と中央の
  アラートアイコンは承認待ちのまま（amber）変えない
- サブPC側の材料は`GET /api/dispatch`（`useDispatchState`）から来る。**取得間隔をActionsの実行状況
  ポーリングと同じ20秒に揃えた**（従来は無風時60秒）。間隔が違うと、同じ「実行中」でも実行先に
  よって画面へ出るまでの速さが変わる。叩き先は自前のDBのみでGitHub APIは消費しない

### 計画・質問の待ちは`activity`に現れない（#2238）

**画面から答えられる待ちを作っている間、セッションは`activity`を1度も報告しない。**
`ExitPlanMode`・`AskUserQuestion`の`PreToolUse`分岐（`scripts/session-notify.sh`）は、
issue-deckへ待ちを作り、そのまま画面の返事をポーリングして止まる。この経路には
`POST /api/dispatch/sessions/activity`への報告が無い。**pollerは1巡ごとに`lastReportedAt`だけを
更新する**ので報告の古さでも落ちず、直前の`WORKING`／`RESPONDED`が残ったまま
`isSessionActivelyWorking`（上の表と同じ判定）が真になる。

このため#2174の「エージェントが動いている確認待ちは数えない」がそのまま当たり、
**行に「計画を承認」「質問に答える」が並んでいるのに左メニューの件数は`0`**（一覧のヘッダーは
`0件・実行中2件`）になっていた。ベル・画面内のトーストも同じ集合を読むので一緒に伏せられる。

- **判定材料に待ちそのものを足す。** `src/lib/check-user-attention.ts`が
  `planRequests`／`questionRequests`を受け取り、`WAITING`が1件でもあれば他の材料より先に
  「実行中ではない」と決める。引き当ては一覧の行がボタンを出すのと同じ
  `findPlanRequestForIssue`／`findQuestionRequestForIssue`を通す——別々に書くと、
  ボタンは出ているのに数から外れる食い違いが戻る
- **`activity`の報告をこの経路へ足す形は採らなかった。** 待ちは`GET /api/dispatch`が既に
  横断で返しており、こちらの方が「人が押せるものがある」ことの直接の根拠になる。
  フックからの追加の報告を増やすと、答えた後に元へ戻す責任も増える
- **Push通知も同じ待ちを見て、3分の待ち時間を飛ばす**（`notifications/check-user-push.ts`の
  `decideCheckUserPush`）。待ち時間の意味は「理由ラベルが揃うのを待つ」「早すぎる
  `00.check-user`が自動で消えるのを待つ」の2つで、待ちがあるならどちらも当てはまらない。
  **質問の待ち時間は既定5分**なので、3分待つと残り2分で届くことになっていた
- **#2280より前はSignalyへの通知（#2061・#2189）と両方鳴っていた。** Signalyを消したので、
  今はこのPush通知だけが「画面から答えられる待ちができた」ことを外へ出す

## 既知の制約

- **人が承認プロンプトに答えたこと自体は、どのフックにも現れない。** #1357で`PostToolUse`
  （承認したツールが走ったこと）を代わりの手掛かりにしたが、**ツールを走らせない答え方は
  拾えない**。承認を拒否した場合と、`AskUserQuestion`以外の質問にテキストで答えただけで
  ツールが動かない場合は、従来どおり`Stop`まで入力待ちのままになる
- **`Stop`は応答の終了ごとに発火する。** 無人で回す実装セッションは
  「起動 → 数十分作業 → Stop」でほぼ1回だが、`21.plan-required`のように人が途中で答える
  Issueではturnごとに飛ぶ。多すぎたときの間引きは実運用の数字を見てから入れる
- 他リポジトリ（`dayspan`等）の`run-issue-session.sh`は別のコピーなので、この仕組みは
  issue-deckのセッションにしか掛かっていない。横展開は
  [local-quick-start.md](local-quick-start.md)のローカル起動プロトコルの版数と一緒に扱う
- **「応答終了」を知らせる手段は無くなった**（#2280）。issue-deckのPush通知は`00.check-user`が
  付いたIssueだけを鳴らすので、作業が終わったことは画面（一覧のバッジ・Issue詳細）を見に行くまで
  分からない。**Signalyを消すときに承知のうえで捨てた**もので、必要になったら`Stop`の報告
  （`activity: responded`）を材料に通知を足せる

## 通知先を消すときは、そこだけが宛先の引き上げを探す（#2280）

Signalyへのwebhook通知を消すにあたって、**送信をやめるだけでは黙って死ぬ経路が1つあった**。
APIエラーで中断したセッションの引き上げ（#1971）は、状態の記録もissue-deckへの報告も持たず
**Signalyへ通知するだけ**の設計で、通知先を消した時点で「止まったまま」を誰にも伝えられなくなる。

- **grepで探すのは送信の呼び出しではなく、送信「しか」しない分岐。** `session-notify.sh`では
  `decision`が`notify`のときだけ状態記録と報告の両方を飛ばしていた（＝webhookが唯一の出口）
- **置き換え先は「同じ性質の引き上げ」に合わせる。** 最初は既存の`checkUserRequested`
  （`/activity`）へ相乗りさせようとしたが、それだと`interrupt_detail`の行き先が無くなり、
  理由ラベルも`01.check-input`（＝回答待ち）になってしまう。実際にやることは
  **続け方の指示**なので、異常終了（`escalateFailedSession`）と同じ`01.check-blocked`に揃えた
- **消す側の`activity`にも注意。** 引き上げは「今どうしているか」を言えないので`activity`を
  持たない。様子の報告と同じ条件（`[[ -n "$ACTIVITY" ]]`）で括ると、そもそも通らない
