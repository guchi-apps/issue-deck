# 実装セッションの状態通知とRemote Control

サブPC（`subpc`）のtmuxで動く実装セッションが、入力待ちと応答終了を自分からSignalyへ通知する
仕組み（#1219）。あわせて`--remote-control`で、通知に気づいた側がスマホやブラウザから
そのセッションへ答えられるようにする。

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
  ↓ webhook（~/.config/issue-deck/notify.env の SESSION_NOTIFY_WEBHOOK_URL）
Signaly → スマホ・メインPCへ通知
  ↓ 通知に載っているURLを開く
claude.ai/code/<セッション> （--remote-control）→ その場で答える
```

### 通知とは別に、ホストへも記録する（#1256）

セッションの自動回収は「最後の`Stop`からどれだけ経ったか」「今は人の入力待ちか」を判定材料に
するが、**通知を投げるだけではホストに何も残らない**。そこで`session-notify.sh`は、送信の前に
`<epoch> <Stop|permission_prompt|working>`の1行を状態ファイルへ書く。

`working`（#1357）は「入力待ちに人が答えて作業へ戻った」。**この記録は回収の判定材料であると
同時に、`PostToolUse`を間引く鍵でもある**（後述）。回収側から見れば`Stop`以外なので、
`permission_prompt`と同じく畳まない側に倒れる。

**記録はwebhookの設定より前に行う。** 送信先の判定を先に置くと、通知を設定していないホストで
記録も行われず、回収がまったく効かなくなる。記録の失敗は1行のログに留め、通知もセッションも
止めない。書式と使い道は
[作業が終わったセッションは自動で畳む](local-quick-start.md#作業が終わったセッションは自動で畳む1256)を参照。

## 計画はIssueのコメントへ残す（#1342）

**`21.plan-required`のIssueをここで起こすと、計画はセッションの中にしか残らなかった。**
画面に出るのは「入力を待っています」というバッジだけで（後述の#1264）、中身はRemote Controlを
開くまで見えない。プロンプト（`scripts/prompts/implementation-agent.md`）は計画をIssueへ投稿する
よう指示していたが、**エージェントが従うかどうかに依存していて担保が無い。**

そこで`ExitPlanMode`の`PreToolUse`フックで計画本文を掴み、issue-deckを経由してIssueへ書く。

```text
ExitPlanMode（計画の提示）
  → PreToolUse フック → session-notify.sh
       → POST /api/dispatch/sessions/plan
            → Issueへ計画コメントを投稿（末尾にRemote Controlのリンク）
            → 00.check-user を付与
       → ホストに「ラベルを付けた」印を残す（<セッション名>.check-user）
            → 返事待ち（SessionPlanRequest）を作り、そのidを返す（#2061）
       → ホストに「ラベルを付けた」印を残す（<セッション名>.check-user）
       → Signalyへ「計画の承認待ち」を通知（#2061）
       → GET /api/dispatch/sessions/plan/decision?id=… を3秒おきに引いて待つ
  → 人がissue-deckの画面で「承認」／「修正を送る」を押す
       → allow ／ deny＋修正の本文 を返す（＝承認プロンプトは出ない）
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
- **このイベントからSignalyへ送るのは「計画の承認待ち」だけ**（#2061）。従来はここで送らず、
  直後に飛ぶ承認プロンプトの`Notification`に任せていた（同じ「入力待ち」が二重になるため）。
  画面から承認できるようになると、承認された場合は承認プロンプトが出ない＝`Notification`が
  飛ばないため、任せたままだと**計画が出たことが誰にも通知されない**。載せるのは他の
  イベントと同じ項目だけで、**計画本文は入れない**（下の「通知の中身」と同じ理由）
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

- **画面から答えられるのは、待っている間だけ。** 待ち時間（既定30分）が切れると`EXPIRED`に
  なり、端末に従来どおりの承認プロンプトが出る。画面には残り時間がカウントダウンで出る
- **待っている間、端末には承認プロンプトが出ない。** 端末に座っているなら`Esc`で中断すれば
  すぐプロンプトへ戻せる。画面の「端末・Remote Controlで答える」を押しても同じ
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
- 待ち時間は`~/.config/issue-deck/notify.env`の`SESSION_PLAN_WAIT_SECONDS`（秒。`0`で待たない。
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
- サーバー側は`src/lib/dispatch/session-plan-request.ts`（値の検証・表示の判定）と
  `src/lib/dispatch/plan-requests.ts`（DB）。画面は`plan-approval-panel.tsx`、
  一覧の導線は`issue-list.tsx`＋`lib/remote-control-attention.ts`、案内の文言は
  `lib/github/check-user-guidance.ts`

### フックが何をしたかは転記の`hook_success`で追える

**フックの標準出力・標準エラー・所要時間・終了コードは、転記（`~/.claude/projects/<スラッグ>/<セッションID>.jsonl`）に
`{"type":"attachment","attachment":{"type":"hook_success",...}}`として残る**（#2108で判明）。フックは
端末に何も出さないまま終わることがあり、Signalyにもissue-deckにも残らないため、**ここが唯一の記録**になる。

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

## 飛ばすのは2種類だけ

`--permission-mode auto`（#1205）により承認プロンプトは激減しているので、飛ばすのは
**「本当に人の判断が要るもの」と「完了」**に絞る。判定は
[scripts/session-notify.sh](../../scripts/session-notify.sh)が持つ。

| フック | 条件 | 意味 | 通知 |
| --- | --- | --- | --- |
| `Notification` | `notification_type` が `permission_prompt` | 承認プロンプト・`AskUserQuestion`の質問 | 🙋 入力待ち |
| `Notification` | `notification_type` が `idle_prompt` | 応答終了から60秒アイドル | **送らない** |
| `Stop` | — | 応答の終了。無人で回すセッションでは実質「作業完了」 | ✅ 応答終了 |
| `PreToolUse` | `tool_name` が `ExitPlanMode` | 計画の提示（#1342） | **送らない**（Issueのコメントへ回す） |
| `PostToolUse` | 状態ファイルの最後のイベントが `permission_prompt` | 人が答えて作業へ戻った（#1357） | **送らない**（issue-deckの画面へだけ回す） |
| `SessionStart` | — | Claude Codeが開始した（#1465） | **送らない**（ホスト側の印を消すだけ。後述） |

**`idle_prompt`を捨てるのは、直前の`Stop`と必ず二重になるため。** 応答が終わって60秒
放置されると発火するので、`Stop`を送った約60秒後に同じ内容がもう1件飛ぶことになる。
通知が多すぎると意味を失う。

`--permission-mode auto`でも`AskUserQuestion`では`permission_prompt`が発火する（実測）。
autoは「Claudeが自分で判断してよいもの」を自動承認するだけで、人に聞く意思そのものは
潰さないため、この経路は生きている。

`SessionEnd`は使っていない。tmuxのウィンドウを閉じただけのイベントに通知の価値が薄い。

## 通知の中身

載せるのは Issue番号・リポジトリ名・ホスト名・イベント種別・`tmux attach`のコマンド・
IssueのURL・Remote ControlのURL（取れたときだけ）・**開発環境のURL**（#1265。
`23.preview-required`のセッションで`tailscale serve`が通っているときだけ）。

**応答テキスト（`Stop`フックの`last_assistant_message`）は載せない。** 応答本文には
Issue本文の引用・ファイルの中身・コマンドの出力が混ざりうる。それを外部サービスである
Signalyへ出す経路を最初から作らない。中身はRemote ControlのURLから見る。

## fieldsの値にリンクを載せるときの制約（#1234・#1247）

**Signalyのfieldsの値でリンクになるのは`[表示名](URL)`のマスクドリンク記法だけで、生URLを
置いても自動ではリンクにならない。** そのうえで、次の2つを守らないと表示が壊れる。

1. **URLに`_`を含めない**（含む場合は`%5F`へパーセントエンコードする）
2. **1つの値にリンクを2つ以上入れない**

理由はSignaly側のレンダラ（`frontend/app.js`の`renderFieldValue`）の処理順にある。
`[表示名](URL)`を`<a href="..." target="_blank" rel="noopener noreferrer">`へ置換した**あとで**
`_..._`を`<em>`へ変換するため、**生成後のHTMLに残る`_blank`の`_`が、値の中の他の`_`と対になる**。
対になった時点でhrefとtarget属性ごと壊れる。

```text
[セッションを開く](https://claude.ai/code/session_01ABC)
→ <a href="https://claude.ai/code/session<em>01ABC" target="</em>blank" ...>
```

つまり「値に残る`_`が2個以上」が壊れる条件で、マスクドリンク1つにつき`_blank`の`_`が1個増える。
Remote ControlのURL（`session_XXX`）は`_`を1個持つので、素直にマスクドリンクへ入れると必ず対になる。

- #1234では、これを避けるためにマスクドリンクをやめて生URLに戻した。しかしSignalyには
  自動リンク検出が無いためリンクにならず、しかもIssueリンク（マスクドリンク）と同じ値へ
  `·`で連結していたので、結局`_blank`と`session_`が対になって両方壊れていた（#1247）
- #1247では、URL中の`_`を`%5F`にしたうえでマスクドリンクへ戻し、IssueリンクとセッションURLを
  別々のフィールドへ分けた。`%5F`は`_`のパーセントエンコードなので指す先は変わらない
- 生URLも`Remote Control URL`フィールドに別途載せている。**スマホのプッシュ通知の本文は
  Signaly側がMarkdownを除去する**ため（`backend/push.py`の`_plain_text`）、マスクドリンクだけだと
  プッシュ通知には表示名しか残らずURLが消える。単独の値なら`_`は1個だけなので壊れない

実機で確認した結果（#1247）。

| 書式 | カードでリンクになるか | 開けるか |
| --- | --- | --- |
| `[表示名](.../session%5FXXX)` | なる | 開く |
| `[表示名](.../session_XXX)` | なる | **開かない**（hrefに`<em>`が混入する） |
| 生URL `.../session_XXX` | **ならない** | — |
| `[表示名](URLに_なし)` | なる | 開く |

`scripts/session-notify.sh`の`signaly_link()`がこのエンコードを行う。**fieldsへリンクを足す
ときは必ずこの関数を通し、1フィールド1リンクを保つこと。**

CI/デプロイ通知（`.github/scripts/signaly-notify.sh`）の`[Workflow Run](...)`はURLに`_`を
含まないため、この問題は起きていない。

## CI/デプロイ通知とチャンネルを分ける

セッション通知は**CI/デプロイ通知とは別のSignalyチャンネル・別の1Passwordフィールド**を使う
（#1231）。

| 通知 | 1Passwordのフィールド | 環境変数 | 設定場所 |
| --- | --- | --- | --- |
| CI/デプロイ | `apps/issue-deck` の `ci-webhook-url` | `SIGNALY_WEBHOOK_URL` | GitHubのrepository secret（正は1Password。対応は`.github/secrets-manifest.tsv`、同期は`scripts/sync-github-secrets.sh`。#1302） |
| セッション状態 | `apps/issue-deck` の `session-webhook-url` | `SESSION_NOTIFY_WEBHOOK_URL` | `~/.config/issue-deck/notify.env` |

分ける理由。

- **性質が違う。** CI/デプロイ通知は結果の記録で、見逃してもGitHubに残る。セッションの
  入力待ちは今すぐ人が答えないとセッションが止まる。混ぜると、後者を後者として扱えない
- **頻度が違う。** `Stop`は応答ごとに発火し、`21.plan-required`のIssueではturnごとに飛ぶ
  （後述の既知の制約）。CIのチャンネルに混ぜると、リリース失敗の通知が埋もれる
- 全アプリ共通の運用でも、ログイン通知は`login-webhook-url`としてCI/デプロイ通知と
  別チャンネルに分けている。種類ごとにチャンネルを分けるのが既定

**Signalyでのチャンネル作成と1Passwordへのフィールド登録は人間の作業で、エージェントは
実行できない。**

## セットアップ

1. **【人間】** Signalyにセッション通知用のチャンネルを作り、Webhook URLをコピーする。
   CI/デプロイ用のチャンネルを再利用しない
2. **【人間】** 1Passwordの`apps/issue-deck`に`session-webhook-url`として登録する
3. `deploy/subpc/notify.env.example` を `~/.config/issue-deck/notify.env` へ置き
   （**chmod 600**）、1Passwordから値を書き出す。

   ```bash
   install -D -m 600 deploy/subpc/notify.env.example ~/.config/issue-deck/notify.env
   WH=$(op read "op://apps/issue-deck/session-webhook-url") || exit 1
   [ -n "$WH" ] || exit 1
   printf 'SESSION_NOTIFY_WEBHOOK_URL=%s\n' "$WH" >> ~/.config/issue-deck/notify.env
   ```

   **代入を`export`と分けること・`2>&1`を付けないこと。** `export WH=$(op read ... 2>&1)`
   と書くと、返るのは`export`の終了コードなので`op`の失敗を検出できず、エラーメッセージが
   値に混入してそのままwebhook URLとして書き込まれる（#1231で実際に踏んだ）。中間ファイル
   （`/tmp`等）を介さないのも、消す前に他ユーザーから読まれうるため
4. **書き出した直後に手で1回発火させ、届くことを確認する**（次節）
5. フックの設定は`run-issue-session.sh`が起動のたびに生成する（`PostToolUse`だけは
   リポジトリの`.claude/settings.json`にも入っている。#1456）ので、他にやることは無い

**この設定をしていないPCでは、`session-notify.sh`は黙って何もしない。** メインPCで同じ
リポジトリのセッションを起動しても通知は飛ばない。

`SESSION_NOTIFY_WEBHOOK_URL`が未設定のときは旧名の`SIGNALY_WEBHOOK_URL`も読む。#1231より前に
設定した`notify.env`をそのまま動かすための互換で、新規に設定するときは新しい名前を使う。

## 設定したら1回手で発火させる

`session-notify.sh`はフックから呼ばれる限り**何が起きても`exit 0`で返す**（後述）。
つまり**設定が壊れていても、セッション側には何の兆候も出ない。** 気づける唯一の機会が、
手で叩いたときのstderrなので、設定・変更のたびに1回実行する。

```bash
printf '{"hook_event_name":"Stop","session_id":"manual-test"}' \
  | scripts/session-notify.sh 1231 issue-deck guchi-apps/issue-deck
```

- 成功: Signalyのセッション通知チャンネルに `✅ [issue-deck #1231] 応答終了 (サブPC)` が届く。
  標準出力・標準エラーには何も出ない
- 失敗: `session-notify: Signalyへの通知に失敗しました（実装は続行します）` がstderrに出る。
  URLが誤り・値にエラーメッセージが混入している・Signalyが落ちている、のいずれか

`SESSION_NOTIFY_DRY_RUN=1`を付けると送信せずにpayloadだけを出力する。**これはpayloadの
組み立てまでしか見ておらず、webhook URLが正しいかは検証されない**（#1231で壊れていたのは
まさにURL側だった）。届くことの確認には必ず実際に発火させる。

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
  生成されるので、ここに置くと**同じ入力待ちがSignalyへ二重に飛ぶ**。`PostToolUse`は
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

## 通知の障害でセッションを止めない

通知経路の障害で実装が止まるのは本末転倒なので、`session-notify.sh`は**何が起きても
`exit 0`で返す**。webhookのURLが未設定でも、`curl`が失敗しても、`python3`が無くても同じ。
`curl`には`--max-time 10`を掛けてあり、応答が返らないwebhookでセッションを待たせない。

フックが非0で終了してもClaude Codeは`Failed with non-blocking status code`と表示して続行する
（実測）が、セッションのログに毎回エラーが出ると本来見たいものが読めなくなるため、
そもそも非0を返さない。なお**exit 2はフックの規約でブロッキング扱いになるので絶対に返さない**。

失敗をログに出すときもURLは出さない。webhookのURLはそれ自体が投稿権限を持つシークレットで、
tmuxのスクロールバックに残る。

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

そこで`session-notify.sh`が、Signalyへの通知と同じタイミングで
`POST /api/dispatch/sessions/activity`へも投げる。

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
- **Signalyへは送らない。** 答えたのは人自身で、同じことを通知し返す意味が無い
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

### 一覧のバッジを回す条件（#1439）

一覧の各行にある進捗バッジ（`WorkflowStepBadge`）は、円グラフで進捗（Project Status）を、
外周のリングの回転で「今動いている」ことを表す。**回転はGitHub Actionsの実行中にしか出て
おらず、サブPCで走っているIssueは止まって見えていた**（回転の条件が`isRunning`＝Actionsの
実行状況ポーリングだけを見ていたため。#1262で「サブPCのIssueはActionsのポーリングから外す」と
決めた際、外した側の代わりを用意していなかった）。

**回転の意味を「今この瞬間、エージェント側が動いている」の一点に決め、判定を
`src/lib/workflow-badge-activity.ts`の`isWorkflowBadgeSpinning`へ集約した。**

| 実行先 | 状態 | 回す | なぜ |
| --- | --- | --- | --- |
| Actions | 実行が進行中 | ○ | 従来どおり |
| Actions | ポーリング結果が未取得・実行が無い | × | 分からないうちは回さない |
| Actions | 起動待ち（Statusは進んでいるのに実行が無い） | × | 起動していない。文言側が「起動待ち」を出す |
| サブPC | セッションが`ALIVE`で`activity`が`WAITING_INPUT`以外 | ○ | `null`・`WORKING`・`RESPONDED`はエージェントが動いている |
| サブPC | セッションが`ALIVE`で`activity`が`WAITING_INPUT` | × | 人待ちで止まっている。文言側が「入力待ち」を出す |
| サブPC | `EXITED`/`FAILED`/`GONE` | × | 終わっている |
| サブPC | `ALIVE`だが`lastReportedAt`が5分より古い | × | pollerは60秒ごとに報告する。5分の無音はサブPC側が落ちている |
| 共通 | 承認待ち（`00.check-user`） | × | バッジ中央のアラートアイコン（人が対応する番）と矛盾する |

- **人待ちで回さない**のがこの整理の芯。回転は一覧を流し見したとき最初に目に入る動きなので、
  「動いていないのに回っている」を許すと合図として使えなくなる
- **`RESPONDED`（応答を終えた）も回す側に置く。** `summarizeIssueSession`が同じものをtone
  `running`として扱っているためで、判定を割ると同じ画面の別の場所で「実行中」と「実行中でない」が
  同時に出る
- **報告の古さで止める歯止めが要る。** `GONE`へ倒すのもpollerの報告なので、サブPCごと落ちると
  行は`ALIVE`のまま残り、誰も回転を止められない
- サブPC側の材料は`GET /api/dispatch`（`useDispatchState`）から来る。**取得間隔をActionsの実行状況
  ポーリングと同じ20秒に揃えた**（従来は無風時60秒）。間隔が違うと、同じ「実行中」でも実行先に
  よって画面へ出るまでの速さが変わる。叩き先は自前のDBのみでGitHub APIは消費しない

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
