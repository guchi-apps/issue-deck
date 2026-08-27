# 全アプリ共通の共有知識リポジトリ（shared context）設計

GitHub Actions上のClaude Codeは実行のたびに独立した環境で起動し、前回の実行やほかのリポジトリでの
実行が得た知見を引き継げない。この「セッションが消えると知見も消える」問題を、**セッションではなく
Git管理されたドキュメントを引き継ぐ**方式で解消するための設計をまとめる。

```text
過去のClaude Code → 実装・調査 → 新しい知見
                                    ↓
        ┌───────────────────────────┴───────────────────────────┐
   対象リポジトリの docs/ ・CLAUDE.md                    Issueに残す知見メモ
   （実装PRに同梱してそのままマージ）              <!-- knowledge-candidate -->
                                                                │
                                                    格上げ判定エージェント
                                          （guchi-apps/docs のGitHub Actions。
                                            フリート全リポジトリのメモを審査）
                                                                ↓
                                                共有知識(guchi-apps/docs)へPR → 人間がマージ
        └───────────────────────────┬───────────────────────────┘
                                    ↓
                            次回のClaude Code が参照
```

**知見を出す側（実装・レビューの各エージェント）は、共有知識へ格上げすべきかどうかを判定しない**
（#2029）。判定はフリートに1つだけ置いた専用エージェントが担う。各リポジトリ・各エージェントの
プロンプトに同じ判定基準を書き写すのをやめ、判定のばらつきと更新漏れを無くすため。

人間・実装エージェント・レビューエージェントの3者が同じファイルを読む構成にすることが目的であり、
AI専用のストレージや埋め込みDBは導入しない。

---

## 1. 現在の構成

### 知識の置き場所

| 置き場所 | 内容 | ローカル実行から読めるか | GitHub Actions実行から読めるか |
|---|---|---|---|
| `~/.claude/CLAUDE.md`（個人環境のグローバル） | 日本語で回答する・Git/GitHub運用・シークレット管理などの横断ルール。実体は`guchi-apps/claude-config`で、両機がsymlinkで同じファイルを見る（#1190） | ✅ | ❌ |
| `~/.claude/skills/`（個人環境のスキル） | `git-github-ja`・`changelog-ja`・`secrets-1password`等。実体は上と同じく`guchi-apps/claude-config` | ✅ | ❌ |
| `~/.claude/projects/<slug>/memory/`（メモリ） | Claude Codeが会話中に自動で書く記録。**機体ローカルで、メインPC・サブPC間で同期されない** | ✅（そのマシンのぶんだけ） | ❌（毎回空） |
| issue-deckの`CLAUDE.md` | issue-deck固有の運用ルール（ラベル遷移・自動マージ不可カテゴリ等） | ✅ | ✅ |
| issue-deckの`docs/` | 設計ドキュメント（`multi-agent-workflow.md`ほか） | ✅ | ✅ |
| `.github/workflows/*.yml`のプロンプト | 各エージェントの責務・手順 | —（Actions専用） | ✅ |
| `guchi-apps/docs`（別リポジトリ） | アプリ開発の標準・規約・共通ガイド（`CLAUDE.md`＝索引、`standards/`・`knowledge/`・`agent-rules/`・`guides/`・`templates/`・`label-sync/`） | ✅（`~/apps/_docs`にcloneしてあれば） | ✅（`.shared-context/`へcheckoutする） |

このうち**メモリだけが、機体をまたいでも実行経路をまたいでも引き継がれない**。同期しない理由と、
メモリに書いた内容をどこへ昇格させるかは
[multi-agent/personal-config-sync.md](multi-agent/personal-config-sync.md)「メモリを同期せず
『昇格』させる」を参照する。

### 自動化の構成

`.github/workflows/`配下でIssue起点の無人実行が完結している（詳細は
[docs/multi-agent-workflow.md](multi-agent-workflow.md)）。

- `claude-issue-dispatch.yml` — `@claude`コメントを起点に計画提示／実装／PR作成／質問応答を無人実行
- `claude-review-develop.yml` — develop向けPRの自動レビュー・自動マージ不可判定・Auto-merge
- `claude-conflict-resolve.yml` / `claude-ci-fix.yml` — コンフリクト・CI失敗の自動修正
- `issue-labels.yml` — ラベル状態遷移
- `release-develop-to-main.yml` — develop→mainのリリースPR自動化

ほかリポジトリへの展開方式は[docs/cross-repo-automation.md](cross-repo-automation.md)（調査）と
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)（実務手順）で整理済みで、
`m-guchi/shopping-list`への導入実績がある。

## 2. 問題点

1. **グローバルルールがActionsに届かない。** issue-deckの`CLAUDE.md`冒頭にも明記しているとおり、
   Actions実行はチェックアウトしたワークツリーしか参照できず、`~/.claude/CLAUDE.md`と個人環境の
   スキルは読み込まれない。そのため「日本語で書く」「コミットのAuthorを固定する」といった全アプリ
   共通のルールを、各リポジトリの`CLAUDE.md`と各ワークフローのプロンプトに**手で複製**している。
2. **複製した共通ルールが同期しない。** issue-deck・shopping-listそれぞれの`CLAUDE.md`に同じ内容を
   書いた時点で、一方だけを更新すると静かにずれる。ラベル体系で実際に起きた事故（世代交代に
   shopping-list側が追随せず、`gh issue edit`が実行時エラーになった。
   [cross-repo-automation.md](cross-repo-automation.md)のケーススタディ参照）と同じ構造の問題。
3. **知見が失われる。** ある実行で判明した非自明な事実（例:「既定の`GITHUB_TOKEN`では
   `.github/workflows/`配下へpushできない」「`permissions:`に存在しないスコープを書くと構文が妥当でも
   ワークフローが発火しなくなる」）は、そのIssueのコメントやPR本文には残るが、**次の実行が読む場所
   には残らない**。同じ調査を毎回やり直すか、同じ失敗を繰り返す。
4. **知見の置き場所の判断基準がない。** アプリ固有の知見と再利用可能な知見を分ける明文化された
   基準がないため、`guchi-apps/docs`は人間向けの設計基準に閉じたままで、エージェントが得た運用知見が
   蓄積されていない。
5. **共有知識を書き換える経路が無制限になりやすい。** 逆に、実装エージェントが共有リポジトリへ
   直接コミットできるようにすると、1つのIssueの都合で全アプリの前提が書き換わり、誤りや一時的な
   情報が全リポジトリに伝播する（知識の汚染）。

## 3. 推奨アーキテクチャ

### 3.1 知識を2層に分ける

| 層 | 置き場所 | 判定基準 | 更新経路 |
|---|---|---|---|
| **アプリ固有** | 対象リポジトリの`CLAUDE.md` / `docs/` | そのリポジトリのコード・スキーマ・画面・ラベル・ワークフローに依存する内容 | 実装PRに同梱し、通常のレビュー・マージで反映 |
| **全アプリ共通** | `guchi-apps/docs`（共有知識リポジトリ） | リポジトリを1つ差し替えても内容が変わらない内容 | 知見メモ → 格上げ判定エージェント → 専用PR → **人間がマージ** |

**どちらに置くかを実装エージェントが決める必要はない**（#2029）。知見は必ずアプリ固有として
対象リポジトリの`docs/`へ書き、同じ内容を知見メモとしてIssueに残す。共有側へ上げるかどうかだけを
格上げ判定エージェントが判定する。判定に使う基準は
[6.3 判定基準](#63-判定基準格上げ判定エージェントが使う)を参照。

### 3.2 共有知識リポジトリは新設せず `guchi-apps/docs` を拡張する

`guchi-apps/docs`（ローカルでは`~/apps/_docs`）は既に「アプリ開発の標準・規約・共通ガイド」として
稼働しており、VPS構成・1Password運用・ブランチ運用・GitHub Actions手順・ラベル同期スクリプトを
持っている。ここに`shared-ai-context`相当を新設すると、Git運用ルールやデプロイ方針が2箇所に
分散し「どちらを更新すべきか」が毎回判断事項になる。

そのため**新規リポジトリは作らず、`guchi-apps/docs`にAIエージェント向けのエントリポイントと
知見置き場を追加する**。設計基準は`standards/`を一次情報源とし、
`CLAUDE.md`はそこへの索引・読む順序を与える薄い層に徹する（内容を二重管理しない）。

必要なファイルの一覧は[6. 共有知識リポジトリ側に必要なファイル](#6-共有知識リポジトリ側に必要なファイル)を参照。

### 3.3 Actionsからは checkout して読ませる

各アプリのワークフローが、自リポジトリのcheckoutに続けて共有知識リポジトリを
`.shared-context/`へcheckoutする。Claude Codeは追加の設定なしにワークツリー内のファイルとして
`Read`/`Grep`/`Glob`で読める。

```text
$GITHUB_WORKSPACE/
├── CLAUDE.md              ← アプリ固有ルール（優先）
├── docs/                  ← アプリ固有の設計・知見
├── src/ ...
└── .shared-context/       ← guchi-apps/docs のcheckout（読み取り専用・.gitignore済み）
    ├── CLAUDE.md
    ├── agent-rules/
    ├── knowledge/
    └── guides/
```

- `actions/checkout`の`path:`は`$GITHUB_WORKSPACE`配下しか指定できないため、ワークツリー内に置く。
  誤コミットを防ぐため`.gitignore`に`/.shared-context/`を登録し、あわせて各プロンプトで
  「`.shared-context/`配下は読み取り専用、`git add`しない」ことを明示する。
- 共有知識リポジトリはprivateのため、checkoutには**その1リポジトリだけへ絞ったGitHub Appの
  インストールトークン**を使う（#2388。未登録のリポジトリでは従来の`secrets.WORKFLOW_PAT`へ
  落ちる。[7.2 事前設定](#72-事前設定人間が行う)参照）。
- checkoutに失敗しても**ジョブは止めない**（`continue-on-error: true`）。共有知識は「あれば
  精度が上がる」補助情報であり、これが理由で実装そのものが止まる方が損失が大きい。プロンプト側で
  「`.shared-context/`が存在しない場合は共有知識なしで進める」と明示する。

### 3.4 参照の優先順位

内容が矛盾する場合は、**具体的で近いものを優先**する。

1. Issue本文・コメントでの明示的な指示
2. 対象リポジトリの`CLAUDE.md`
3. 対象リポジトリの`docs/`
4. `.shared-context/CLAUDE.md` および `.shared-context/agent-rules/`
5. `.shared-context/knowledge/` ・ `.shared-context/standards/`（設計基準）・`.shared-context/guides/`

共有知識は「他のアプリではこうしている」という既定値であり、アプリ固有ルールを上書きしない。

### 3.5 書き込みは一方通行にする

実装エージェントは共有知識リポジトリへ**書き込まない**。得た知見は対象リポジトリの`docs/`へ
書くのと同時に「知見メモ」としてIssueコメントに残すだけで、実際の反映は格上げ判定エージェントが
作るPRを人間がマージしたときに初めて起こる。

```text
実装エージェント                格上げ判定エージェント                          人間
      │                    （guchi-apps/docs のGitHub Actions）                  │
  知見メモ ──────────────────────────▶ フリート全リポジトリの                    │
  <!-- knowledge-candidate -->          未判定メモを集めて審査                    │
                                                │                               │
                                        通ったものだけ                           │
                                   guchi-apps/docs へPR作成 ────────────────────▶ マージ
                                                │
                                        判定結果を出典Issueへコメントし
                                   <!-- knowledge-promotion:judged --> を付ける
```

## 4. 必要な変更

以下は導入当時（#1741）の変更一覧。**#5の`shared-knowledge-propose.yml`と、#4のうち
「共有知識追加提案の審査」は#2029で廃止し、判定と反映は`guchi-apps/docs`側の格上げ判定
エージェントへ移した**（[9章](#9-共有知識更新フロー)）。

| # | 対象 | 変更内容 |
|---|---|---|
| 1 | `.gitignore` | `/.shared-context/`を追加（誤コミット防止） |
| 2 | `CLAUDE.md` | 「共有知識リポジトリ」節を追加（参照先・優先順位・書き込み禁止・提案フロー） |
| 3 | `.github/workflows/claude-issue-dispatch.yml` | 共有知識のcheckoutステップを追加し、計画提示／実装／質問応答の各プロンプトに参照ルールと知見の振り分けルールを追記 |
| 4 | `.github/workflows/claude-review-develop.yml` | claude-reviewジョブに共有知識のcheckoutを追加し、レビュー観点に「共有知識との整合性」と「共有知識追加提案の審査」を追加 |
| 5 | `.github/workflows/shared-knowledge-propose.yml`（新規。**#2029で廃止**） | developマージ後、承認済みの提案だけを共有知識リポジトリへのPRに変換していた |
| 6 | `scripts/prompts/implementation-agent.md` / `review-agent.md` | ローカルセッション用プロンプトにも同じルールを追記 |
| 7 | `scripts/run-issue-session.sh` / `scripts/start-reviewer.sh` | ローカル実行時に`~/apps/_docs`を`--add-dir`で参照可能にする |
| 8 | `docs/multi-agent-workflow.md` / `docs/cross-repo-setup-guide.md` | 共有知識層の位置づけ・他リポジトリ導入時の手順を追記 |
| 9 | 共有知識リポジトリ側 | [6章](#6-共有知識リポジトリ側に必要なファイル)のファイル群を追加（このリポジトリからは変更できないため、内容を文書化するにとどめる） |

## 5. 実際に変更するファイル（このリポジトリ）

- `.gitignore`
- `CLAUDE.md`
- `docs/shared-knowledge.md`（本ファイル・新規）
- `docs/multi-agent-workflow.md`
- `docs/cross-repo-setup-guide.md`
- `.github/workflows/claude-issue-dispatch.yml`
- `.github/workflows/claude-review-develop.yml`
- `.github/workflows/shared-knowledge-propose.yml`（新規。#2029で削除済み）
- `scripts/prompts/implementation-agent.md`
- `scripts/prompts/review-agent.md`
- `scripts/run-issue-session.sh`
- `scripts/start-reviewer.sh`

## 6. 共有知識リポジトリ側に必要なファイル

`guchi-apps/docs`に以下を追加する。**このリポジトリからは変更できないため、実ファイルの追加は
別途`guchi-apps/docs`側で行う。** 追加前でも`.shared-context/`のcheckout自体は成功し、
存在しないファイルはプロンプト側の「無ければ共有知識なしで進める」指示で吸収される。

```text
guchi-apps/docs/
├── README.md                      # 入口だけを残したスタブ（索引はCLAUDE.mdへ一本化）
├── CLAUDE.md                      # 唯一の索引。読む順序・優先順位・書き込み禁止・提案フロー
├── agent-rules/                   # エージェントの役割別ルール
│   ├── implementation.md          #   実装エージェント共通ルール
│   ├── review.md                  #   レビュー・統合エージェント共通ルール
│   └── knowledge-contribution.md  #   知見の振り分け基準と提案フォーマット
├── standards/                     # 全アプリ共通の決定事項（1テーマ1ファイル）
│   ├── README.md                  #   standards の索引（いつ読むか付き）
│   ├── tech-stack.md / ports.md / directory-layout.md
│   ├── secrets.md / database.md / auth.md
│   ├── branching.md / ci-deploy.md / infrastructure.md
│   └── coding.md                  #   コーディング方針
├── knowledge/                     # 実際に踏んだ落とし穴・非自明な挙動
│   ├── README.md                  #   知見ファイルの索引と書き方
│   ├── github-actions.md / github-app.md / git-github-operations.md
│   ├── multi-agent-workflow.md / preview-environments.md
│   ├── deployment.md / nextjs-prisma.md / supabase.md
│   └── common-gotchas.md
├── guides/                        # 手作業の設定手順（大半はエージェントには実行できない）
│   └── new-app-checklist.md       #   新規アプリ作成チェックリスト
├── templates/
└── label-sync/
```

構成は「1テーマ1ファイル・見出しは結論・冒頭に『いつ読むか』の1行」で統一している。
エージェントの読解コストのうち最も大きいのは「どのファイルを読むべきかの判断」であり、
索引と冒頭1行がそこを直接下げるため。

### 6.1 `CLAUDE.md`（エントリポイント）に書くこと

内容を二重に持たず、**どこに何があるか**と**読む順序**だけを持たせる。

- このリポジトリが全アプリ共通の知識層であり、アプリ固有ルールが優先されること
- 読む順序: `agent-rules/`（自分の役割のもの）→ 必要に応じて`knowledge/`の該当ファイル →
  設計判断が要るときだけ`standards/`・`guides/`
- 各ディレクトリの索引（1行説明つき）
- 「このリポジトリへ直接コミットしない。変更は提案フロー（`agent-rules/knowledge-contribution.md`）
  を通す」ことの明示
- 全アプリ共通の言語・記述ルール（コミットメッセージ・PR本文・Issueコメントは日本語、
  コミットAuthorは`Claude Code <claude-code@example.com>`）

現状issue-deckの`CLAUDE.md`とワークフローのプロンプトに複製されている共通ルールのうち、
ここへ移せるものは移し、アプリ側には「共有知識の該当箇所を参照する」旨だけを残す。ただし
**移行は一度に行わず、共有側に書いた内容が実際に読まれていることを確認してからアプリ側の
記述を削る**（Actionsが共有知識を読めないまま記述だけ消えると、ルールが失われる）。

### 6.2 `agent-rules/` に書くこと

| ファイル | 内容 |
|---|---|
| `implementation.md` | 実装エージェントの共通責務と禁止事項（`main`/`develop`への直接push禁止、他Issueブランチの編集禁止、不要なforce push禁止、自己マージ禁止）、コミット・PR本文の書き方、無人実行時の振る舞い（依存追加が必要なら止めて確認を求める・行き詰まったら黙って終わらない） |
| `review.md` | レビュー・統合エージェントの共通観点（Issue要件充足・既存設計との整合・ルール順守・共有知識との整合・テスト結果・セキュリティ・他機能への影響）、自動マージ不可カテゴリ、`main`への直接マージ禁止 |
| `knowledge-contribution.md` | 知見をアプリ固有／共通のどちらに置くかの判定基準、提案コメントのフォーマット、審査4観点、共有側へ書いてはいけないもの（シークレット・個人情報・一時的な障害情報・特定Issue番号に依存する記述） |

### 6.3 判定基準（格上げ判定エージェントが使う）

**この基準を使うのは格上げ判定エージェントだけ**で、実装エージェント・レビューエージェントの
プロンプトには書かない（#2029）。同じ基準を各所に書き写すと、更新が片方だけに入って判定が
ばらつくため。

**共有知識に置く**（すべて満たす）:

- 対象リポジトリを別のアプリに差し替えても内容が成立する
- 少なくとも2つのアプリ、または「今後の全アプリ」に当てはまる見込みがある
- 数週間以上有効であることが見込まれる（恒久的な仕様・制約・方針）
- 出典または再現条件が示せる（公式ドキュメント、実際に踏んだ事象と実行ログ等）

**アプリ固有として対象リポジトリの`docs/`に置く**:

- 特定のディレクトリ構成・スキーマ・画面・ラベル・ワークフロー定義に依存する
- そのアプリの過去のIssue経緯を前提にしないと意味が通らない
- 判断に迷う（迷ったらこちら。知見メモの出典リポジトリの`docs/`には既に書かれているため、
  格上げしなくても知見自体は失われない）

**どちらにも置かない**:

- シークレットの実値、個人情報、外部に出せない認証情報
- 一時的な障害・特定バージョンのバグで、解消後に価値が残らないもの
- 既存の記述と重複するだけで新しい情報がないもの

### 6.4 `knowledge/` の書き方

1ファイル1テーマ、1知見1セクション。各セクションに以下を含める。

```markdown
## <一行で分かる結論>

- **状況**: いつ・どこで問題になるか
- **結論**: 何をすべきか / 何をしてはいけないか
- **根拠**: 出典URL、または再現した事象と実行ログへのリンク
- **確認日**: YYYY-MM-DD
- **出典リポジトリ**: guchi-apps/issue-deck#<Issue番号>
```

「確認日」を必ず持たせることで、古くなった知見を後から棚卸しできるようにする。

### 6.5 初期投入する知見の候補

issue-deckで既に判明していて、他アプリでも再利用できるもの。

- 既定の`GITHUB_TOKEN`は`.github/workflows/`配下へpushできない（リポジトリ設定をRead and writeに
  しても解除されない）。workflowスコープを持つFine-grained PATが必須（issue-deck #106）
- `permissions:`に存在しないスコープを書くと、構文が妥当でもワークフローのトリガー自体が発火
  しなくなる（issue-deck #103 → #115）
- `GITHUB_TOKEN`起点のpush・PR作成・マージは他のワークフローを起動しない。連鎖させたい場合は
  実PAT由来のトークンを使い、あわせて`schedule`による取りこぼし回収ジョブを併設する（#112）
- `claude-code-action`は実行時にcheckoutの認証情報を自前トークンへ差し替えるため、
  `git push`用の認証は`remote.origin.pushurl`に固定して分離する（#662）
- `claude-code-action`の非人間アクター拒否機構により、bot作成PRのレビューには`allowed_bots`の
  明示が必要（#80/#81）
- Actions上の無人実行では対話的な承認者がいないため、承認ゲートはラベル（`00.check-user`）の
  付与・解除で表現し、エージェントの完了報告は必ず独立したシェルステップで検証・フォールバックする
- 1Password Service Accountによるシークレット注入は`actions/checkout`より後にしか実行できないため、
  checkoutの`token`入力に渡す値だけはGitHub Secretsへ直接登録する必要がある

## 7. GitHub Actionsの変更

### 7.1 共有知識のcheckout

`claude-issue-dispatch.yml`（計画提示・実装・質問応答）と`claude-review-develop.yml`（レビュー）の
Claude Code実行前に、以下のステップを挟む。

```yaml
- name: 共有知識リポジトリをcheckoutする
  uses: actions/checkout@v4
  continue-on-error: true
  with:
    repository: ${{ vars.SHARED_CONTEXT_REPO || 'guchi-apps/docs' }}
    ref: ${{ vars.SHARED_CONTEXT_REF || 'main' }}
    path: .shared-context
    fetch-depth: 1
    persist-credentials: false
    token: ${{ steps.shared-context-token.outputs.token || secrets.WORKFLOW_PAT }}
```

`shared-context-token`はこのcheckoutの直前に置く、**共有知識リポジトリだけを対象にした**
インストールトークンの発行ステップ（#2388）。ジョブ内の他のトークン（`app-token`）は実行中の
リポジトリにしかスコープされないため、別リポジトリを読むには別途発行が要る。

```yaml
- name: 共有知識リポジトリの所有者とリポジトリ名を分解する
  id: shared-context-target
  env:
    SHARED_CONTEXT_REPO: ${{ vars.SHARED_CONTEXT_REPO || 'guchi-apps/docs' }}
  run: |
    set -euo pipefail
    echo "owner=${SHARED_CONTEXT_REPO%%/*}" >> "$GITHUB_OUTPUT"
    echo "repo=${SHARED_CONTEXT_REPO##*/}" >> "$GITHUB_OUTPUT"
- name: 共有知識リポジトリ用のインストールトークンを発行する
  id: shared-context-token
  if: ${{ vars.WORKFLOW_APP_ID != '' }}
  continue-on-error: true
  uses: actions/create-github-app-token@v3
  with:
    app-id: ${{ vars.WORKFLOW_APP_ID }}
    private-key: ${{ secrets.WORKFLOW_APP_PRIVATE_KEY }}
    owner: ${{ steps.shared-context-target.outputs.owner }}
    repositories: ${{ steps.shared-context-target.outputs.repo }}
    permission-contents: read
```

- `vars.SHARED_CONTEXT_REPO` / `vars.SHARED_CONTEXT_REF`はリポジトリ変数での上書き用。未設定なら
  `guchi-apps/docs`の`main`を読む。他リポジトリへ展開する際、ワークフロー本文を書き換えずに
  切り替えられるようにするための逃げ道。
- `persist-credentials: false`にして、共有知識リポジトリの認証情報が`.shared-context/.git/config`に
  残らないようにする（本体リポジトリのpush認証と混線させない）。
- `continue-on-error: true`により、トークンの権限不足・リポジトリ名の誤り等で失敗しても実装は続行する。
  **トークン発行ステップ側にも`continue-on-error: true`が要る。** checkoutだけに付けても、その手前の
  発行が失敗した時点でジョブが落ちる（#2388）。
- `repositories:`に渡すのは`owner/repo`ではなく**リポジトリ名だけ**。ワークフローの式には文字列を
  分割する関数が無いため、`vars.SHARED_CONTEXT_REPO`の分解はシェルのステップで行う。

### 7.2 事前設定（人間が行う）

- **issue-deckのGitHub Appは`repository_selection: all`でインストールされているため、共有知識
  リポジトリ向けの追加設定は不要。** `.shared-context/`のcheckoutは、そのリポジトリだけへ絞った
  インストールトークン（`permission-contents: read`）で動く（#2388）。
  `vars.WORKFLOW_APP_ID`が未登録のリポジトリでは、従来どおり`secrets.WORKFLOW_PAT`
  （Repository accessが「All repositories」）へ落ちる。
  `guchi-apps/docs`へのブランチpush・PR作成は、#2029以降は`guchi-apps/docs`側の格上げ判定
  ワークフローが自リポジトリのトークンで行うため、issue-deck側には書き込み権限が要らない。
- 他リポジトリへ展開する場合は、そのリポジトリの`WORKFLOW_PAT`が共有知識リポジトリへ到達できるかを
  確認する。リポジトリを個別指定しているPATの場合は`guchi-apps/docs`を追加する必要がある。
- PATが共有知識リポジトリへ到達できない場合でも、checkoutステップは`continue-on-error: true`の
  ため各ワークフローは停止しない（共有知識なしで実行される）。

### 7.3 知識反映ワークフロー

**このリポジトリには置かない。** 格上げの判定と共有知識への反映は`guchi-apps/docs`側の
ワークフローが行う。詳細は[9章](#9-共有知識更新フロー)を参照。

## 8. Claude Codeへのコンテキストの渡し方

| 実行形態 | 渡し方 |
|---|---|
| GitHub Actions（無人） | `.shared-context/`へcheckout。プロンプトに「参照先」「優先順位」「読み取り専用」「知見の振り分け」を明記する。`allowedTools`には既に`Read`/`Grep`/`Glob`が含まれているため追加は不要 |
| ローカル（`scripts/start-issue.sh`経由） | `claude --add-dir "$HOME/apps/_docs"`で共有知識リポジトリを参照可能にする。存在しない場合は`--add-dir`を付けずに起動する |
| ローカル（レビュー、`scripts/start-reviewer.sh`経由） | 同上 |
| **ローカル（`/issue` スラッシュコマンド）** | **`--add-dir`が効かない。** `--prepare-only`で既存のClaude Codeタブの中で動くため、セッション起動時の引数を渡す経路が無い。`.claude/commands/issue.md`の手順に「共有知識を読む」ステップを置いて対応している（#1098） |

**起動経路によって参照できる情報が変わらないようにする。** 同じIssueでも、画面のボタンから
起動したセッションは共有知識を読めて、`/issue`から始めたセッションは読めない、という状態は
運用上の事故になる（実際#1098として顕在化した）。渡し方の手段は経路ごとに違ってよいが、
**最終的にエージェントが読む情報は揃える**こと。

プロンプトへは知識の**全文を埋め込まない**。ファイルの場所と読む順序だけを渡し、必要なものを
エージェント自身に読ませる。全文埋め込みはトークンを浪費するうえ、共有知識が増えるほど
プロンプトの更新漏れが起きるため。

ローカル実行では`~/.claude/CLAUDE.md`と個人環境のスキルも読み込まれる。内容が矛盾した場合は
[3.4 参照の優先順位](#34-参照の優先順位)に従い、リポジトリの`CLAUDE.md`を最優先とする。

## 9. 共有知識更新フロー

**格上げ判定は、フリートに1つだけ置いた専用エージェントが行う**（#2029）。知見を出す側は
判定しない。判定基準を各リポジトリ・各エージェントのプロンプトへ書き写す運用をやめ、判定の
ばらつきと更新漏れを無くすため。

### 9.1 知見メモ（実装エージェント）

実装・調査の過程で非自明な知見を得たら、次の2つを**両方**行う。

1. 対象リポジトリの`docs/`または`CLAUDE.md`へ書き、実装PRに同梱する
2. 同じ内容を「知見メモ」として対応Issueへコメントする

````markdown
<!-- knowledge-candidate -->
### 既定のGITHUB_TOKENは.github/workflows/配下へpushできない

- 状況: ワークフローファイル自体を変更するIssueをActionsで無人実装したとき
- 結論: workflowスコープを持つFine-grained PATを`actions/checkout`の`token`に渡す
- 根拠: 実行ログ <URL>。リポジトリのWorkflow permissionsをRead and writeにしても解消しない
- 確認日: 2026-08-09
- 出典: guchi-apps/issue-deck#106

<!-- issue-deck-agent:implementer -->
````

- **共有知識へ格上げすべきかどうかは書かない。** 反映先ファイル（かつての`target:`）も選ばない。
  どちらも格上げ判定エージェントが決める
- 知見が複数ある場合は`###`の見出しを知見ごとに立て、1つのコメントにまとめる
  （マーカー`<!-- knowledge-candidate -->`はコメントの先頭に1つだけ）
- 1回の実装で残す知見は目安3件まで。無い場合はコメントを投稿しない（「知見なし」の空コメントは
  投稿しない）
- シークレットの実値・個人情報・一時的な障害情報は、`docs/`にも知見メモにも書かない

**レビュー・統合エージェントは知見メモを審査しない。** かつての4観点審査
（`<!-- shared-knowledge-verdict:* -->`）は廃止した。

### 9.2 格上げ判定（`guchi-apps/docs`のワークフロー）

判定エージェントは`guchi-apps/docs`のGitHub Actionsとして動き、issue-deckを含む
`guchi-apps`配下の全リポジトリを対象に、定期実行で次を行う。

1. 各リポジトリのIssueから、`<!-- knowledge-candidate -->`があり
   `<!-- knowledge-promotion:judged -->`が**まだ無い**ものを集める。**対象を日付で絞らない**ため、
   判定エージェントが止まっていた期間のメモも後から遡って拾える
2. 対応する実装がマージ済み（`issue-<番号>`ブランチのPRがマージ、またはIssueがclose）の
   ものだけを判定対象にする。未マージの作業から得た知見は共有知識へ上げない
3. [6.3 判定基準](#63-判定基準格上げ判定エージェントが使う)と、既存の`knowledge/`との重複の
   有無で、各知見を承認／却下する
4. 承認したものだけを`knowledge/`配下へ書き、`guchi-apps/docs`へのPull Requestを作成する
   （デフォルトブランチへの直接pushはしない）
5. 判定結果（承認・却下と理由、作成したPRのURL）を出典Issueへコメントし、末尾に
   `<!-- knowledge-promotion:judged -->`を付ける。このマーカーが再実行時の二重処理を防ぐ

**判定エージェントを置くのが`guchi-apps/docs`側である理由**（#2029）。知識を守る側が門番を持つ
ため、issue-deckを含むどのアプリも共有知識への書き込み権限を持たなくてよい。収集元リポジトリが
増えても各リポジトリ側の変更が要らない。フリート全体を巡回して1つのPRにまとめる先例が
同リポジトリの`build-inventory.yml`にある。

### 9.3 反映（人間のマージ）

**共有知識リポジトリのデフォルトブランチへ直接pushすることはしない。** 反映は常にPR経由で、
最終的なマージは人間が行う。これにより、実装エージェントの記録ミス・判定エージェントの誤承認の
いずれが起きても、人間のマージ操作という関門で止められる。

### 9.4 汚染を防ぐための3重のガード

| ガード | 内容 |
|---|---|
| 1. 書き込み経路の分離 | 知見を出す側には共有知識リポジトリへの書き込み手段を与えない（`.shared-context/`は`.gitignore`済み・読み取り専用。Actionsのcheckoutも`persist-credentials: false`。書き込みができるのは`guchi-apps/docs`側のワークフローだけ） |
| 2. 判定 | 格上げ判定エージェントが[6.3 判定基準](#63-判定基準格上げ判定エージェントが使う)と重複の有無で審査し、通らなかったものは共有知識へ上がらない（知見自体は出典リポジトリの`docs/`に残る） |
| 3. 人間のマージ | 反映は必ず`guchi-apps/docs`へのPRとして提示され、マージは人間が行う |

判定エージェントは複数リポジトリの知見を1つのPRにまとめることがあるため、**PRと出典Issueは
1対1にならない**。追跡は各セクションの「出典リポジトリ」と、出典Issueへ投稿される判定結果
コメントで行う。

## 10. 各エージェントの役割分担

| 項目 | 実装エージェント | レビュー・統合エージェント |
|---|---|---|
| 起動 | Issueへの`@claude`コメント（`claude-issue-dispatch.yml`） | develop向けPRの作成・更新（`claude-review-develop.yml`） |
| 共有知識 | **読む**（`.shared-context/agent-rules/implementation.md`→必要な`knowledge/`） | **読む**（`.shared-context/agent-rules/review.md`→必要な`knowledge/`） |
| Issue理解・コード調査 | ✅ | 差分の読解のみ |
| 実装・テスト・PR作成 | ✅ | ❌（コードの直接修正は禁止） |
| 知見の記録 | ✅ 実装PRに同梱して`docs/`へ書き、同じ内容を知見メモとしてIssueへ残す | 記録内容の妥当性を確認する |
| 共有知識への格上げ判定 | ❌（判定しない） | ❌（判定しない） |
| 共有知識リポジトリへの書き込み | ❌ | ❌ |

格上げ判定と共有知識への反映は、どちらも`guchi-apps/docs`側の**格上げ判定エージェント**が担う
（[9.2](#92-格上げ判定guchi-appsdocsのワークフロー)）。実装・レビューのどちらのエージェントも
判定に関与しない。
| 自動マージ不可判定 | ❌ | ✅ `00.check-user`の付与 |
| マージ | ❌（自己マージ禁止） | Auto-mergeの有効化のみ。`main`への直接マージは禁止 |

## 未解決の課題・申し送り事項

- **共通ルールの移譲は段階的に行う。** issue-deckの`CLAUDE.md`とワークフローのプロンプトから
  共通ルールを削って共有知識側へ寄せるのは、共有知識が実際に読まれていることを実運用で確認して
  からにする。先に削ると、checkoutの失敗や参照漏れでルールが黙って失われる。
- **共有知識の肥大化への対処は未設計。** `knowledge/`が増えるとエージェントが読む範囲の判断が
  難しくなる。当面は`knowledge/README.md`の索引で足りる想定だが、増えた時点で分割・要約の方針を
  改めて決める必要がある。
- **知見の棚卸し（古い記述の削除）は自動化しない。** 各セクションに「確認日」を持たせるところまでを
  設計し、実際の棚卸しは人間が定期的に行う。
- **知見メモの書式は機械検証していない。** 判定エージェントはマーカーの有無だけを機械的に見て、
  本文の解釈はClaude Codeに委ねる。書式崩れが頻発するようであれば、検証ステップの追加を検討する。
- **判定エージェントが止まると誰も気付かない。** 知見メモは`<!-- knowledge-promotion:judged -->`が
  付くまで残り続けるため取りこぼしは起きないが、判定が何日も走っていないことを検知する仕組みは
  無い。運用してみて問題になるようなら、未判定メモの滞留件数を通知する等を検討する。
- **他リポジトリへの展開時はPATの到達性確認が要る。** issue-deckの`WORKFLOW_PAT`はAll repositories
  のため追加設定は不要だが、共有知識リポジトリがprivateである限り、リポジトリを個別指定した
  PATを使う導入先ではRepository accessの更新が必要になる（読み取りのみ）。逆に、判定エージェントが
  各リポジトリのIssueを読み・コメントするためのトークンは`guchi-apps/docs`側で用意する。

## 関連ドキュメント

- [docs/multi-agent-workflow.md](multi-agent-workflow.md) — issue-deck自身のマルチエージェント運用の設計
- [docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md) — 他リポジトリへの導入手順
- [docs/cross-repo-automation.md](cross-repo-automation.md) — 展開方式の調査・比較
- [CLAUDE.md](../CLAUDE.md) — issue-deckの運用ルール本体
