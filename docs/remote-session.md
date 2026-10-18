# リモートセッション（#4743）

左メニュー「構想・相談」・スマホホームの「リモートセッション」（`?pane=remote-sessions`／
`?mscreen=remote-sessions`）から、**リポジトリだけを指定してサブPCにClaude Codeのセッションを立て、
Claude Codeアプリへ移動する**。会話そのものはIssueDeckではなくClaude Codeアプリ（claude.ai/code・
モバイルアプリ）で行う。アプリ内チャット（#3975・[chat.md](chat.md)）はこれに置き換えた。

## 流れ

```text
画面「セッションを起動」→ POST /api/remote-sessions
  └ RemoteSession（starting）＋ DispatchJob（REMOTE_SESSION・tmuxSessionName=<repo>-remote-<8文字>）
       poller（claim）→ run_remote_session_job
         └ scripts/start-remote-session.sh <owner> <repo> <セッション名>
              既定ブランチの最新から detached の worktree を作る（~/apps/<repo>-worktrees/remote-<8文字>）
              tmux で claude --remote-control <セッション名> --permission-mode <auto> を起こす
         └ ~/.claude/sessions/<pid>.json の bridgeSessionId からURLを組み立てる（最大90秒待つ）
       POST /api/dispatch/report（succeeded・remoteControlUrl）→ RemoteSession（running・URL）
画面 → GET /api/remote-sessions を3秒おきに読み、URLが届いたらそのURLへ移動する
```

- **URLが取れなくても起動は成功として返す。** URLは非公開仕様のファイルから取るbest-effortで、
  取れなかった巡はホスト申告（`POST /api/dispatch/hosts`の`remoteSessions`）が後から届ける。画面は
  150秒待って届かなければ自動移動をやめ、一覧の「開く」が押せるようになるのを待つ
- **終了**は`DELETE /api/remote-sessions?id=`が`REMOTE_SESSION_KILL`を積み、pollerが
  `start-remote-session.sh --kill`でtmuxを畳んでworktreeを片付ける
- tmuxを直接閉じた・Claude Codeが終了した・ホストを再起動したものは、ホスト申告に出てこなくなって
  3分で`ended`になる。worktreeはpollerの巡回（`--sweep`）が片付ける

## 実装セッションと混ぜない

| 項目 | リモートセッション | Issueの実装セッション |
|---|---|---|
| tmux名 | `<repo>-remote-<8文字>` | `<repo>-issue-<番号>` |
| 状態の持ち場所 | `RemoteSession` | `DispatchSession` |
| 生存の報告 | ホスト申告の`remoteSessions` | `POST /api/dispatch/sessions` |
| フック（session-notify） | 渡さない | `--settings`で渡す |
| 引き上げ・停滞検知・自動再開・回収 | 対象外 | 対象 |
| 同時実行数 | ホストごとに既定3本（`REMOTE_SESSION_MAX`・`REMOTE_SESSION_MAX_PER_HOST`） | `DISPATCH_MAX_SESSIONS` |

`DispatchSession`へ`issueNumber=0`で載せる案は採らなかった。Issue向けの一覧・引き上げ・回収の処理が
`-issue-`の規約と`issueNumber`で動いており、Issueに紐づかない行が紛れ込むと誤判定するため。
ジョブ（`REMOTE_SESSION`・`REMOTE_SESSION_KILL`）は枠外ジョブ（`OUT_OF_BAND_JOB_KINDS`）として配り、
実行状況の一覧には出さない（状態はこの画面が持つ）。

## 権限と作業場所

- **権限モード**は実装セッションと同じ`ISSUE_DECK_CLAUDE_PERMISSION_MODE`（既定`auto`）。人が
  Claude Codeアプリから対話する作業用セッションなので、書き込みツールは封じない
- **作業場所はそのセッション専用のworktree**。本体チェックアウトは使わない（pollerの自己更新・
  他セッションと作業ツリーを取り合うため）。detached HEADで始まるので、変更を残すならセッションの中で
  ブランチを切ってpushする
- **フォルダの信頼確認**は本体チェックアウトのパスで判定され、worktreeでは出ない
  （`scripts/lib/claude-trust.sh`）。本体が未信頼なら、起動前に`claude_trust_require`で止めて理由を返す
- **worktreeは作業が残っていないときだけ消す。** 未コミットの変更があるか、HEADがどのリモートブランチ
  からも辿れない（pushしていないコミットがある）ときは残し、パスを終了の結果に出す
- 開発サーバーは起動しない。依存のインストールもしない（要ればセッションの中で行う）

## 対応の申告

pollerの版数40から`remoteSession: true`を申告する（ランチャーと`claude`が揃っているとき）。申告していない
ホスト（古いpoller）には配らず、画面は「pollerが対応していません。更新して再起動してください」を出す。
`--remote-control`への対応はランチャーが起動時に`claude --help`で確かめ、未対応なら理由を付けて失敗で返す。

## 関連ファイル

- 判定と表示（DBに触らない）: `src/lib/dispatch/remote-session-rules.ts`
- 積む・反映・一覧: `src/lib/dispatch/remote-session.ts`
- 画面のAPI: `src/app/api/remote-sessions/route.ts`
- 画面: `src/components/dashboard/remote-session-view.tsx`・`src/hooks/use-remote-sessions.ts`
- サブPC: `scripts/start-remote-session.sh`・`scripts/subpc-dispatch-poller.sh`（`run_remote_session_job`・`remote_session_list_json`）
