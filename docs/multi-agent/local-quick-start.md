# 画面からのローカルセッション起動（クイックスタート）

issue-deckの画面の「ローカルで開始」から、WSL上のClaude Codeセッションをワンクリックで
起動する仕組み（#1049）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## なぜ必要だったか

起動経路は3つあるが、自動化されていたのは2つだけだった。

| 起点 | 実体 | 自動化 |
|---|---|---|
| GitHub Issue（`@claude`コメント・画面の「実装を開始」） | `claude-issue-dispatch.yml` | 全自動（無人実行） |
| WSLのターミナル | `scripts/start-issue.sh` | worktree作成〜devサーバー〜`claude`起動まで全自動 |
| 画面を見ていて「これをローカルでやろう」と思った瞬間 | — | 無かった |

3つ目が抜けているため、実際には「Issue番号を覚える → ターミナルを開く → コマンドを打つ」を
手でつないでいた。ここを画面のボタン1つに畳む。

## 経路

```text
issue-deckの画面「ローカルで開始」
  ↓ issuedeck://start/<owner>/<repo>/<Issue番号>
Windowsのプロトコルハンドラ（%LOCALAPPDATA%\issue-deck\issuedeck-protocol.ps1）
  ↓ wt.exe → wsl.exe → bash -lc
scripts/start-local-session.sh <owner> <repo> <番号>   ← リポジトリ→ローカルパスの解決
  ↓
<対象リポジトリ>/scripts/start-issue.sh <番号>          ← worktree・devサーバー・claude起動
```

**ブラウザからWSLのプロセスを直接起動する手段は存在しない。** そのため、Windows側に
カスタムURLプロトコルを登録し、そのハンドラを踏み台にする。VSCodeが
`vscode://vscode-remote/wsl+<ディストロ>/<パス>` を受けているのと同じ仕組み。

なお**Claude Code拡張（v2.1.227時点）はURIハンドラを登録していない**（`package.json`の
`contributes`に`uriHandler`が無く、`activationEvents`にも`onUri`が無い）。したがって
「deep linkでVSCodeを開き、そのままプロンプト入りのClaude Codeセッションを始める」ことは
できない。起動先をターミナルの`claude` CLI（＝`start-issue.sh`の既存の出口）にしているのは
この制約による。

## 初回セットアップ（1回だけ）

Windows側のPowerShellで実行する。**管理者権限は不要**（HKCU配下に登録するため）。

```powershell
cd \\wsl.localhost\Ubuntu\home\<ユーザー名>\apps\issue-deck
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-issuedeck-protocol.ps1
```

登録スクリプトは、ハンドラ本体を`%LOCALAPPDATA%\issue-deck\`へ複製したうえでレジストリを書く。
WSL上のパス（`\\wsl.localhost\...`）を直接登録しないのは、WSLが停止した状態からの初回起動で
パス解決に失敗しうるため。**`scripts/windows/issuedeck-protocol.ps1`を変更したときは、
登録スクリプトを再実行して複製を更新する。**

解除は`-Unregister`を付けて実行する。

動作確認は、ブラウザのアドレスバーに`issuedeck://start/guchi-apps/issue-deck/1`を入力する。

### WSLディストロ名が`Ubuntu`でない場合

ハンドラは環境変数`ISSUEDECK_WSL_DISTRO`を見る。未設定なら`Ubuntu`を使う。

## 対象リポジトリを増やす

`scripts/start-local-session.sh`が`owner/repo`→ローカルのチェックアウト先を解決する。
既定で解決できるのは`guchi-apps/issue-deck`のみ。他リポジトリは対応表に追記する。

```text
# ~/.config/issue-deck/local-repos.conf
guchi-apps/shopping-list  /home/guchi/apps/shopping-list
```

ただし**ワンクリック起動が成立するのは`scripts/start-issue.sh`を持つリポジトリだけ**で、
2026-08-11時点でこれを持つのはissue-deckのみ（[docs/cross-repo-automation.md](../cross-repo-automation.md)）。
対応表に無いリポジトリや、スクリプトを持たないリポジトリでは、その旨を表示して停止する。

## セキュリティ上の前提

プロトコルを登録すると、この起動経路は**任意のWebページから叩ける**ようになる。悪意ある
ページが`issuedeck://...`を仕込めば、ハンドラは呼ばれる。そのため次を守っている。

- URLは**全体一致の正規表現で検証**し、`owner`・`repo`は`[A-Za-z0-9._-]`、Issue番号は正の整数
  のみを通す。空白・引用符・`;`（Windows Terminalのサブコマンド区切り）・シェルのメタ文字は
  この時点で落ちる。
- `.`を許可文字に含めている都合で`.`・`..`自体は正規表現を通るため、別途弾く（パス走査の防止）。
- 同じ検証をWSL側の`start-local-session.sh`でも行う（多層防御）。
  **片側だけを緩めない。** 緩めた側が単独で穴になる。
- 検証を通った値以外は、コマンドラインへ一切埋め込まない。

起動されうる操作の上限は「issue-deckのworktreeを作り、devサーバーとClaude Codeセッションを
立ち上げる」ところまでで、任意コマンドの実行には至らない。ただしClaude Codeセッション自体は
起動してしまうため、**心当たりのないタブが開いたら閉じる**。

## PowerShellスクリプトはUTF-8 BOM付きで保存する

`scripts/windows/*.ps1`は**UTF-8 BOM付き**でコミットしている。Windows PowerShell 5.1
（`powershell.exe`。Windowsに標準搭載されているもの）は、BOMが無いファイルをANSI（日本語環境では
CP932）として読むため、日本語コメントを含むスクリプトが文字化けし、**構文エラーで動かなくなる**。

実際に、BOM無しで保存した時点では次のエラーになった。

```text
式またはステートメントのトークン '}' を使用できません。
```

エラー行（`}`）は実際の原因箇所ではなく、文字化けした前の行で文字列が閉じられなくなった結果
そこまでずれて報告される。**エラー行を読んでも原因にたどり着けない**ので、`.ps1`で不可解な
構文エラーが出たらまずBOMの有無を疑う。

```bash
head -c 3 scripts/windows/issuedeck-protocol.ps1 | xxd   # efbbbf ならBOM付き
```

## プロトコルが登録されていない環境

ボタンを押しても何も起きない（ブラウザが未知のスキームを無視する）。この場合のフォールバックとして、
Issue詳細の「…」メニューに**「ローカル起動コマンドをコピー」**を用意している。コピーした
コマンドをWSLのターミナルに貼れば、URL経路とまったく同じ`start-local-session.sh`が動く。
経路ごとに挙動が分かれないよう、コマンドの生成も`src/lib/local-session.ts`に集約している。

## `11.local`の自動付与

ボタン押下時に`11.local`を付与してから起動する。ローカルセッションで対応するIssueに無人実行が
重ねて走るのを防ぐため（[labels.md](labels.md)）。ラベル付与に失敗しても起動自体は妨げない
（起動できないより、ラベルが遅れる方が軽いという判断）。

## VSCodeのタブから始める（`/issue <番号>`）

上のワンクリック起動はWindows Terminalの**タブ**を開くため、同時に見えるのは1つだけになる。
VSCodeのClaude Codeタブを横に並べて複数Issueを並行で進める使い方（1ウィンドウ・Nタブ）には、
`.claude/commands/issue.md` のスラッシュコマンドを使う。

```text
VSCodeでClaude Codeのタブを開く（Claude Code: Open in New Tab）
  ↓
/issue 1049
  ↓
worktree準備（scripts/start-issue.sh --prepare-only）→ ラベル付与 → プロンプト適用
```

`--prepare-only`はworktree・ブランチ・`.env.local`・ポート採番・`pnpm install`・起動用
プロンプトの生成までを行い、**開発サーバーもClaude Codeも起動せずに終了する**。既に
セッションの中にいるので、さらに`claude`を起動しても意味がないため。LANアクセス設定
（Windowsの管理者権限＝UACダイアログが出る）も、開発サーバーを立てない以上は不要なので
スキップする。

worktreeが既にある場合は作り直さず再利用する。同じIssueへ戻る操作がここで吸収される。

### worktreeを編集できるようにする

Claude Codeタブのカレントディレクトリは、VSCodeで開いているフォルダ（＝本体チェックアウト）
になる。worktreeはその外にあるため、**そのままではEdit/Writeが通らない**。

その場限りで通すなら、セッション内で一度だけ実行する。

```text
/add-dir ~/apps/issue-deck-worktrees/issue-1049
```

毎回不要にするなら、**本体チェックアウト**の`.claude/settings.local.json`（ローカル専用。
gitで無視される）に追記する。Claudeタブのカレントディレクトリは本体チェックアウトなので、
worktree側ではなくこちらに書く。

```json
{
  "permissions": {
    "additionalDirectories": ["/tmp", "/home/<ユーザー名>/apps/issue-deck-worktrees"]
  }
}
```

パスは絶対パスで書く。このファイルはコミットされないマシン固有の設定なので、`~`の展開に
依存させる必要がない。既存の`additionalDirectories`がある場合は**上書きせず追記する**
（`/tmp`等が消えると別の場所で権限エラーになる）。

**コミット対象の`.claude/settings.json`には書かない。** そちらはGitHub Actions上の無人実行でも
読まれるため、Actions側に存在しないパスを持ち込むことになる。

### なぜ本体チェックアウトで作業しないか

タブを複数開くと、全タブのカレントディレクトリが同じ本体チェックアウトになる。そこで
`git switch`すると**他タブのセッションの作業ツリーごと切り替わる**。実際、このIssueの作業中に
本体が`issue-1049`から`issue-834`へ切り替わり、未コミットの変更が別Issueのセッション側へ
持ち越される事故が起きた。`/issue`が必ずworktreeへ寄せるのはこのため。

### Claude Code純正のworktree機能を使わない理由

Claude Codeには`claude -w/--worktree`とVSCode拡張の`Claude Code: Create Worktree`があるが、
このリポジトリでは採用していない。実測（2026-08-11、CLI 2.1.220 / 拡張 2.1.227）での差分は次のとおり。

| 項目 | 純正worktree | issue-deckの規約 | |
|---|---|---|---|
| 作成先 | `<repo>/.claude/worktrees/<name>` | `~/apps/issue-deck-worktrees/<name>` | リポジトリ内部に入る |
| ブランチ名 | `worktree-<name>` 固定 | `issue-<番号>` | **衝突** |
| 分岐元 | `origin/HEAD`（このリポジトリでは`develop`） | `develop` | 一致 |
| gitignore | 追加されない（`?? .claude/`が出る） | — | 除外設定が要る |

**ブランチ名が決定的**で、`worktree-issue-1049`のような名前になる。`issue-<番号>`の命名規約を
前提にした`issue-labels.yml`等の自動化（[labels.md](labels.md)）が対象外と判定して空振りする。
設定スキーマに`branchPrefix`・`branchName`にあたる項目は無く、コード上も`worktree-${name}`の
ハードコードのため、設定で回避できない。

一方`worktree.symlinkDirectories`で`node_modules`をメインリポジトリから共有できる点は純正が
優れており、`--prepare-only`が毎回`pnpm install`する現状より速い。命名の制約が外れたら再検討する。

## 未対応（このIssueの範囲外）

- **画面のワンクリック起動からの再アタッチ**。`/issue`は既存worktreeを再利用するが、
  `start-issue.sh`を素で叩く経路（＝画面のボタン）はworktreeが既に存在するとエラー終了する。
- マージ済みworktreeの**掃除**。放置すると溜まり、上記と組み合わさって
  「一度やったIssueはボタンから起動できない」状態になる。
