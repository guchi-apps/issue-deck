---
description: Issue番号を指定して、専用worktreeでのローカル実装を開始する
argument-hint: <Issue番号>
---

Issue #$1 のローカル実装を開始してください。

このコマンドは、VSCodeのClaude Codeタブから使うことを想定しています（#1049）。
タブを複数開いてIssueごとに並行作業できるよう、**作業場所は必ずIssue専用のworktree**に
します。本体チェックアウト（`~/apps/issue-deck`）は他タブのセッションが使っている可能性が
あるため、**ブランチを切り替えたり、そこへコミットしたりしないでください。**

## 手順

1. `$1` がIssue番号（正の整数）として妥当か確認する。妥当でなければ、何もせず使い方を示して止まる。

2. worktreeを用意する。**あってもなくても同じコマンドでよい。**

   ```bash
   bash ~/apps/issue-deck/scripts/start-issue.sh --prepare-only $1
   ```

   worktree・ブランチ`issue-$1`の作成、`.env.local`のコピー、開発サーバー用ポートの採番、
   `pnpm install`、起動用プロンプトの生成までを行い、Claude Codeも開発サーバーも起動せずに
   終了する（このセッションが既にClaude Codeなので、さらに起動しても意味がないため）。

   **worktreeが既にある場合は作り直さず再利用する**（#1076）。未コミットの変更が残っていれば
   件数が表示されるので、あればユーザーに提示してから続きに入る。gitの作業ツリーでない
   ディレクトリがあるときや別ブランチを開いているときはエラー終了するので、その場合は
   勝手に消さずユーザーに状況を伝える。

3. 以降の作業ディレクトリを worktree に固定する。`cd ~/apps/issue-deck-worktrees/issue-$1` を
   基点にし、**本体チェックアウトのファイルは読むだけ**にする。

   worktreeは`--add-dir`で許可されていないと編集できない。編集が拒否される場合は、
   `/add-dir ~/apps/issue-deck-worktrees/issue-$1` を一度実行するようユーザーに依頼する
   （恒久的に通す方法は [docs/multi-agent/local-quick-start.md](../../docs/multi-agent/local-quick-start.md) 参照）。

4. Issueの最新の内容を取得する。

   ```bash
   gh issue view $1 --repo guchi-apps/issue-deck --comments
   ```

5. ラベルを付ける。**忘れやすいので必ず行う。**

   - `11.local` — ローカルセッションで対応中であることを示す。これが付いている間、
     無人実行（`claude-issue-dispatch.yml`）はこのIssueに手を出さない。二重起動の防止。
   - 進捗ラベル — `21.plan-required` が付いていれば `01.planning`、付いていなければ `02.wip`。

6. `~/apps/issue-deck-worktrees/.prompts/issue-$1.md` を読み、そこに書かれた実装エージェント
   向けの指示（責務・画面確認・スクリーンショット・知見の記録・禁止事項）に従って進める。
   `--prepare-only`で用意したworktreeでは**開発サーバーは起動していない**ので、画面確認が
   必要になったら worktree 内で `pnpm dev` をバックグラウンド起動する。

7. `21.plan-required` が付いている場合は、実装前に計画（アプローチ・変更範囲・懸念点）を
   提示して承認を得る。付いていなければそのまま実装に進んでよい。

## 禁止事項

- 本体チェックアウト（`~/apps/issue-deck`）でのブランチ切り替え・コミット
- 他Issueのworktreeの編集
- `main` / `develop` への直接コミット・push
- 自分が作成したPull Requestの自己マージ
