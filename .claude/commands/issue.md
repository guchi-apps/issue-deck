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

   worktree・ブランチ`issue-$1`の作成、`.env.local`のコピー（再開時は本体にあって不足しているキーだけを追記）、開発サーバー用ポートの採番、
   `pnpm install`、起動用プロンプトの生成までを行い、Claude Codeも開発サーバーも起動せずに
   終了する（このセッションが既にClaude Codeなので、さらに起動しても意味がないため）。

   **worktreeが既にある場合は作り直さず再利用する**（#1076）。未コミットの変更が残っていれば
   件数が表示されるので、あればユーザーに提示してから続きに入る。gitの作業ツリーでない
   ディレクトリがあるときや別ブランチを開いているときはエラー終了するので、その場合は
   勝手に消さずユーザーに状況を伝える。

   そのIssueのPRが**既にマージ済み**の場合は「警告: このIssueのPR #… は既にマージ済みです」
   と表示される（#1100）。この経路は端末を持たないため、警告だけ出してそのまま再利用する。
   ただし古いブランチ（developから分岐し直されていない）で作業を始めることになるので、
   **勝手に進めずユーザーに確認する**。作り直してよいと言われたら`--recreate`を付けて
   実行し直す（未コミットの変更や未pushのコミットが残っている場合は作り直さずエラーで止まる）。

   ```bash
   bash ~/apps/issue-deck/scripts/start-issue.sh --prepare-only --recreate $1
   ```

3. 以降の作業ディレクトリを worktree に固定する。`cd ~/apps/issue-deck-worktrees/issue-$1` を
   基点にし、**本体チェックアウトのファイルは読むだけ**にする。

   worktreeは`--add-dir`で許可されていないと編集できない。編集が拒否される場合は、
   `/add-dir ~/apps/issue-deck-worktrees/issue-$1` を一度実行するようユーザーに依頼する
   （恒久的に通す方法は [docs/multi-agent/local-quick-start.md](../../docs/multi-agent/local-quick-start.md) 参照）。

4. Issueの最新の内容を取得する。

   ```bash
   gh issue view $1 --repo guchi-apps/issue-deck --comments
   ```

5. ラベルと進捗を確認する。**手順2の`start-issue.sh`が起動時に処理済み**（#1096・#1097）なので、
   通常はここで何もしなくてよい。

   - `11.local` — ローカルセッションで対応中であることを示すラベル。これが付いている間、
     無人実行（`claude-issue-dispatch.yml`）はこのIssueに手を出さない。二重起動の防止。
     出力に付与の行が出ていない場合だけ自分で付ける。
   - 進捗（Project Status） — `21.plan-required` が付いていれば `Planning`、付いていなければ
     `Implementation`。`start-issue.sh`がissue-deckの進捗報告APIへ送る。**進捗ラベルは
     #991 Phase 5（#1010）で廃止済み**なので`gh issue edit`では進められない。スクリプトが
     報告をスキップした旨を出していた場合は、issue-deckの画面（カンバン・「実装を開始」ボタン）
     から進める。**既に`Develop PR`以降まで進んでいるIssueは巻き戻さない**（スクリプト側も
     報告前に現在の進捗を確認している）。

6. 全アプリ共通の共有知識（`~/apps/_docs`）を必要な範囲だけ読む。

   **このコマンドは新しいセッションを起動しないため、共有知識を渡す経路が無い。**
   `scripts/run-issue-session.sh`（画面のボタン・ターミナルからの起動）は
   `--add-dir ~/apps/_docs` を付けてセッションを開くが、`/issue` は `--prepare-only` で
   既存のタブの中で動くのでそれが効かない。**同じIssueでも起動経路によって参照できる情報が
   変わってしまう**ため、ここで明示的に読む（#1098）。

   ```bash
   # 索引。読む順序が書いてある
   ~/apps/_docs/CLAUDE.md
   # 実装エージェントの共通ルール（責務・禁止事項・知見の記録）
   ~/apps/_docs/agent-rules/implementation.md
   ```

   最初から全部読む必要はない。上の2つを読んだうえで、今回触る領域に対応するものがあれば
   `knowledge/`・`standards/`・`guides/` から選ぶ。各ファイルの冒頭に「いつ読むか」の1行がある。

   **内容がこのリポジトリの`CLAUDE.md`・`docs/`と矛盾する場合は、このリポジトリ側を優先する。**
   共有知識は他アプリでの既定値であり、issue-deck固有ルールを上書きしない。

   **共有知識は読み取り専用。** 編集・コミットは行わない。追加すべき知見を得た場合は、
   対応Issueへ「追加提案」コメントを投稿する（[docs/shared-knowledge.md](../../docs/shared-knowledge.md)
   「9. 共有知識更新フロー」参照）。

   `~/apps/_docs` が存在しない場合や読み取りが拒否される場合は、共有知識なしで進めてよい。
   拒否される場合は `/add-dir ~/apps/_docs` を一度実行するようユーザーに依頼する。

7. `~/apps/issue-deck-worktrees/.prompts/issue-$1.md` を読み、そこに書かれた実装エージェント
   向けの指示（責務・画面確認・スクリーンショット・知見の記録・禁止事項）に従って進める。
   `--prepare-only`で用意したworktreeでは**開発サーバーは起動していない**ので、画面確認が
   必要になったら worktree 内で `pnpm dev` をバックグラウンド起動する。

8. `21.plan-required` が付いている場合は、実装前に計画（アプローチ・変更範囲・懸念点）を
   提示して承認を得る。付いていなければそのまま実装に進んでよい。

   計画は端末に提示するだけでなく、`gh issue comment $1` でIssueにも投稿する（#1096）。
   後からこのIssueを無人実行へ引き継いだ場合、無人実行は「承認済みの計画がIssueコメントに
   ある」前提で動くため、端末だけで完結させると経路をまたいだ時点で前提が壊れる。

## 禁止事項

- 本体チェックアウト（`~/apps/issue-deck`）でのブランチ切り替え・コミット
- 他Issueのworktreeの編集
- `main` / `develop` への直接コミット・push
- 自分が作成したPull Requestの自己マージ
