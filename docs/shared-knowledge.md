# 全アプリ共通の共有知識リポジトリ（shared context）設計

GitHub Actions上のClaude Codeは実行のたびに独立した環境で起動し、前回の実行やほかのリポジトリでの
実行が得た知見を引き継げない。この「セッションが消えると知見も消える」問題を、**セッションではなく
Git管理されたドキュメントを引き継ぐ**方式で解消するための設計をまとめる。

```text
過去のClaude Code → 実装・調査 → 新しい知見
                                    ↓
                        アプリ固有か / 全アプリ共通か を判定
                                    ↓
        ┌───────────────────────────┴───────────────────────────┐
   アプリ固有                                              全アプリ共通
   対象リポジトリの docs/ ・CLAUDE.md                共有知識リポジトリ(m-guchi/docs)
   （実装PRに同梱してそのままマージ）                 （提案 → レビュー → 別PR → 人間が承認）
        └───────────────────────────┬───────────────────────────┘
                                    ↓
                            次回のClaude Code が参照
```

人間・実装エージェント・レビューエージェントの3者が同じファイルを読む構成にすることが目的であり、
AI専用のストレージや埋め込みDBは導入しない。

---

## 1. 現在の構成

### 知識の置き場所

| 置き場所 | 内容 | ローカル実行から読めるか | GitHub Actions実行から読めるか |
|---|---|---|---|
| `~/.claude/CLAUDE.md`（個人環境のグローバル） | 日本語で回答する・Git/GitHub運用・シークレット管理などの横断ルール | ✅ | ❌ |
| `~/.claude/skills/`（個人環境のスキル） | `git-github-ja`・`changelog-ja`・`secrets-1password`等 | ✅ | ❌ |
| issue-deckの`CLAUDE.md` | issue-deck固有の運用ルール（ラベル遷移・自動マージ不可カテゴリ等） | ✅ | ✅ |
| issue-deckの`docs/` | 設計ドキュメント（`multi-agent-workflow.md`ほか） | ✅ | ✅ |
| `.github/workflows/*.yml`のプロンプト | 各エージェントの責務・手順 | —（Actions専用） | ✅ |
| `m-guchi/docs`（別リポジトリ） | アプリ開発の標準・規約・共通ガイド（`README.md`＝アプリ設計ガイド、`guides/`・`templates/`・`label-sync/`） | ✅（`~/apps/_docs`にcloneしてあれば） | ❌ |

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
   基準がないため、`m-guchi/docs`は人間向けの設計基準に閉じたままで、エージェントが得た運用知見が
   蓄積されていない。
5. **共有知識を書き換える経路が無制限になりやすい。** 逆に、実装エージェントが共有リポジトリへ
   直接コミットできるようにすると、1つのIssueの都合で全アプリの前提が書き換わり、誤りや一時的な
   情報が全リポジトリに伝播する（知識の汚染）。

## 3. 推奨アーキテクチャ

### 3.1 知識を2層に分ける

| 層 | 置き場所 | 判定基準 | 更新経路 |
|---|---|---|---|
| **アプリ固有** | 対象リポジトリの`CLAUDE.md` / `docs/` | そのリポジトリのコード・スキーマ・画面・ラベル・ワークフローに依存する内容 | 実装PRに同梱し、通常のレビュー・マージで反映 |
| **全アプリ共通** | `m-guchi/docs`（共有知識リポジトリ） | リポジトリを1つ差し替えても内容が変わらない内容 | 提案 → レビュー審査 → 専用PR → **人間がマージ** |

判定に迷う場合はアプリ固有として扱う（共有側を汚さない方向に倒す）。詳細な判定基準は
[6.3 判定基準](#63-判定基準実装エージェントレビューエージェント共通)を参照。

### 3.2 共有知識リポジトリは新設せず `m-guchi/docs` を拡張する

`m-guchi/docs`（ローカルでは`~/apps/_docs`）は既に「アプリ開発の標準・規約・共通ガイド」として
稼働しており、VPS構成・1Password運用・ブランチ運用・GitHub Actions手順・ラベル同期スクリプトを
持っている。ここに`shared-ai-context`相当を新設すると、Git運用ルールやデプロイ方針が2箇所に
分散し「どちらを更新すべきか」が毎回判断事項になる。

そのため**新規リポジトリは作らず、`m-guchi/docs`にAIエージェント向けのエントリポイントと
知見置き場を追加する**。人間向けの`README.md`（アプリ設計ガイド）はそのまま一次情報源として残し、
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
└── .shared-context/       ← m-guchi/docs のcheckout（読み取り専用・.gitignore済み）
    ├── CLAUDE.md
    ├── agent-rules/
    ├── knowledge/
    └── guides/
```

- `actions/checkout`の`path:`は`$GITHUB_WORKSPACE`配下しか指定できないため、ワークツリー内に置く。
  誤コミットを防ぐため`.gitignore`に`/.shared-context/`を登録し、あわせて各プロンプトで
  「`.shared-context/`配下は読み取り専用、`git add`しない」ことを明示する。
- 共有知識リポジトリはprivateのため、checkoutには`secrets.WORKFLOW_PAT`を使う
  （[7.2 事前設定](#72-事前設定人間が行う)参照）。
- checkoutに失敗しても**ジョブは止めない**（`continue-on-error: true`）。共有知識は「あれば
  精度が上がる」補助情報であり、これが理由で実装そのものが止まる方が損失が大きい。プロンプト側で
  「`.shared-context/`が存在しない場合は共有知識なしで進める」と明示する。

### 3.4 参照の優先順位

内容が矛盾する場合は、**具体的で近いものを優先**する。

1. Issue本文・コメントでの明示的な指示
2. 対象リポジトリの`CLAUDE.md`
3. 対象リポジトリの`docs/`
4. `.shared-context/CLAUDE.md` および `.shared-context/agent-rules/`
5. `.shared-context/knowledge/` ・ `.shared-context/README.md`（アプリ設計ガイド）・`.shared-context/guides/`

共有知識は「他のアプリではこうしている」という既定値であり、アプリ固有ルールを上書きしない。

### 3.5 書き込みは一方通行にする

実装エージェントは共有知識リポジトリへ**書き込まない**。得た知見のうち共通と判断したものは
「提案」としてIssueコメントに残すだけで、実際の反映は専用ワークフローが作るPRを人間が
マージしたときに初めて起こる。

```text
実装エージェント          レビューエージェント        shared-knowledge-propose.yml     人間
      │                          │                              │                     │
  提案コメント ──────────────▶ 審査（4観点）                    │                     │
  <!-- shared-knowledge-        │                              │                     │
       proposal -->        verdict:approved / rejected          │                     │
                                │                              │                     │
                        developへマージ ─────────────────────▶ approvedのみ拾う       │
                                                        m-guchi/docs へPR作成 ──────▶ マージ
```

## 4. 必要な変更

| # | 対象 | 変更内容 |
|---|---|---|
| 1 | `.gitignore` | `/.shared-context/`を追加（誤コミット防止） |
| 2 | `CLAUDE.md` | 「共有知識リポジトリ」節を追加（参照先・優先順位・書き込み禁止・提案フロー） |
| 3 | `.github/workflows/claude-issue-dispatch.yml` | 共有知識のcheckoutステップを追加し、計画提示／実装／質問応答の各プロンプトに参照ルールと知見の振り分けルールを追記 |
| 4 | `.github/workflows/claude-review-develop.yml` | claude-reviewジョブに共有知識のcheckoutを追加し、レビュー観点に「共有知識との整合性」と「共有知識追加提案の審査」を追加 |
| 5 | `.github/workflows/shared-knowledge-propose.yml`（新規） | developマージ後、承認済みの提案だけを共有知識リポジトリへのPRに変換する |
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
- `.github/workflows/shared-knowledge-propose.yml`（新規）
- `scripts/prompts/implementation-agent.md`
- `scripts/prompts/review-agent.md`
- `scripts/run-issue-session.sh`
- `scripts/start-reviewer.sh`

## 6. 共有知識リポジトリ側に必要なファイル

`m-guchi/docs`に以下を追加する。**このリポジトリからは変更できないため、実ファイルの追加は
別途`m-guchi/docs`側で行う。** 追加前でも`.shared-context/`のcheckout自体は成功し、
存在しないファイルはプロンプト側の「無ければ共有知識なしで進める」指示で吸収される。

```text
m-guchi/docs/
├── README.md                      # 既存（アプリ設計ガイド本体）。冒頭にCLAUDE.mdへの導線を追記
├── CLAUDE.md                      # ★新規: AIエージェント向けエントリポイント（索引・読む順序）
├── coding-standards.md            # ★新規: 全アプリ共通のコーディング方針
├── agent-rules/
│   ├── implementation.md          # ★新規: 実装エージェント共通ルール
│   ├── review.md                  # ★新規: レビュー・統合エージェント共通ルール
│   └── knowledge-contribution.md  # ★新規: 知見の振り分け基準と提案フォーマット
├── knowledge/
│   ├── README.md                  # ★新規: 知見ファイルの索引と書き方
│   ├── github-actions.md          # ★新規: Actions上でClaude Codeを動かす際の知見
│   ├── git-github-operations.md   # ★新規: Git/GitHub運用の共通知見
│   ├── deployment.md              # ★新規: VPS/PM2/systemdデプロイの共通知見
│   ├── nextjs-prisma.md           # ★新規: Next.js + Prisma スタックの共通知見
│   ├── supabase.md                # ★新規: Supabase等の共通サービスの知見
│   └── common-gotchas.md          # ★新規: 複数アプリで再発しうる落とし穴
├── guides/                        # 既存（人間向け詳細ガイド。CLAUDE.mdから索引する）
├── templates/                     # 既存
└── label-sync/                    # 既存
```

### 6.1 `CLAUDE.md`（エントリポイント）に書くこと

内容を二重に持たず、**どこに何があるか**と**読む順序**だけを持たせる。

- このリポジトリが全アプリ共通の知識層であり、アプリ固有ルールが優先されること
- 読む順序: `agent-rules/`（自分の役割のもの）→ 必要に応じて`knowledge/`の該当ファイル →
  設計判断が要るときだけ`README.md`（アプリ設計ガイド）・`guides/`
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

### 6.3 判定基準（実装エージェント・レビューエージェント共通）

**共有知識に置く**（すべて満たす）:

- 対象リポジトリを別のアプリに差し替えても内容が成立する
- 少なくとも2つのアプリ、または「今後の全アプリ」に当てはまる見込みがある
- 数週間以上有効であることが見込まれる（恒久的な仕様・制約・方針）
- 出典または再現条件が示せる（公式ドキュメント、実際に踏んだ事象と実行ログ等）

**アプリ固有として対象リポジトリの`docs/`に置く**:

- 特定のディレクトリ構成・スキーマ・画面・ラベル・ワークフロー定義に依存する
- そのアプリの過去のIssue経緯を前提にしないと意味が通らない
- 判断に迷う（迷ったらこちら）

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
- **出典リポジトリ**: m-guchi/issue-deck#<Issue番号>
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
    repository: ${{ vars.SHARED_CONTEXT_REPO || 'm-guchi/docs' }}
    ref: ${{ vars.SHARED_CONTEXT_REF || 'main' }}
    path: .shared-context
    fetch-depth: 1
    persist-credentials: false
    token: ${{ secrets.WORKFLOW_PAT }}
```

- `vars.SHARED_CONTEXT_REPO` / `vars.SHARED_CONTEXT_REF`はリポジトリ変数での上書き用。未設定なら
  `m-guchi/docs`の`main`を読む。他リポジトリへ展開する際、ワークフロー本文を書き換えずに
  切り替えられるようにするための逃げ道。
- `persist-credentials: false`にして、共有知識リポジトリの認証情報が`.shared-context/.git/config`に
  残らないようにする（本体リポジトリのpush認証と混線させない）。
- `continue-on-error: true`により、PATの権限不足・リポジトリ名の誤り等で失敗しても実装は続行する。

### 7.2 事前設定（人間が行う）

- **issue-deckの`secrets.WORKFLOW_PAT`はRepository accessが「All repositories」で設定済みのため、
  共有知識リポジトリ向けの追加設定は不要。** `.shared-context/`のcheckoutも、
  `shared-knowledge-propose.yml`による`m-guchi/docs`へのブランチpush・PR作成も、このPATで動く
  （必要なpermissionは`Contents: Read and write`・`Pull requests: Read and write`。
  All repositoriesのPATにはこれらが既に含まれている）。
- 他リポジトリへ展開する場合は、そのリポジトリの`WORKFLOW_PAT`が共有知識リポジトリへ到達できるかを
  確認する。リポジトリを個別指定しているPATの場合は`m-guchi/docs`を追加する必要がある。
- PATが共有知識リポジトリへ到達できない場合でも、checkoutステップは`continue-on-error: true`の
  ため各ワークフローは停止しない（共有知識なしで実行される）。`shared-knowledge-propose.yml`側は
  失敗を検知して対応Issueへフォールバック通知を投稿する。

### 7.3 知識反映ワークフロー（新規）

`.github/workflows/shared-knowledge-propose.yml`。詳細は[9章](#9-共有知識更新フロー)を参照。

## 8. Claude Codeへのコンテキストの渡し方

| 実行形態 | 渡し方 |
|---|---|
| GitHub Actions（無人） | `.shared-context/`へcheckout。プロンプトに「参照先」「優先順位」「読み取り専用」「知見の振り分け」を明記する。`allowedTools`には既に`Read`/`Grep`/`Glob`が含まれているため追加は不要 |
| ローカル（`scripts/start-issue.sh`経由） | `claude --add-dir "$HOME/apps/_docs"`で共有知識リポジトリを参照可能にする。存在しない場合は`--add-dir`を付けずに起動する |
| ローカル（レビュー、`scripts/start-reviewer.sh`経由） | 同上 |

プロンプトへは知識の**全文を埋め込まない**。ファイルの場所と読む順序だけを渡し、必要なものを
エージェント自身に読ませる。全文埋め込みはトークンを浪費するうえ、共有知識が増えるほど
プロンプトの更新漏れが起きるため。

ローカル実行では`~/.claude/CLAUDE.md`と個人環境のスキルも読み込まれる。内容が矛盾した場合は
[3.4 参照の優先順位](#34-参照の優先順位)に従い、リポジトリの`CLAUDE.md`を最優先とする。

## 9. 共有知識更新フロー

### 9.1 提案（実装エージェント）

実装中に得た知見が[6.3 判定基準](#63-判定基準実装エージェントレビューエージェント共通)の
「共有知識に置く」を満たすと判断した場合、**共有知識リポジトリを直接編集せず**、対応Issueへ
以下の形式でコメントを投稿する。

````markdown
<!-- shared-knowledge-proposal -->
### 共有知識への追加提案

```yaml
target: knowledge/github-actions.md
title: 既定のGITHUB_TOKENは.github/workflows/配下へpushできない
```

- **状況**: ワークフローファイル自体を変更するIssueをActionsで無人実装したとき
- **結論**: workflowスコープを持つFine-grained PATを`actions/checkout`の`token`に渡す
- **根拠**: 実行ログ <URL>。リポジトリのWorkflow permissionsをRead and writeにしても解消しない
- **確認日**: 2026-08-09
- **出典**: m-guchi/issue-deck#106

<!-- issue-deck-source:claude-issue-dispatch -->
````

- 1回の実装で投稿する提案は目安3件まで。それを超える場合は重要なものに絞る。
- アプリ固有と判断した知見は提案せず、**実装PRに同梱して**対象リポジトリの`docs/`へ書く。
- 提案が無い場合はコメントを投稿しない（「提案なし」の空コメントは投稿しない）。

### 9.2 審査（レビューエージェント）

`claude-review-develop.yml`のclaude-reviewジョブが、PRレビューの一部として提案を審査する。

判定は4観点すべてを満たすかで行う。

1. **再利用性** — 本当に複数アプリで再利用できるか（1アプリの構成に依存していないか）
2. **正確性** — 根拠が示されており、`.shared-context/`の既存記述や公式仕様と矛盾しないか
3. **重複** — `.shared-context/`に既に同等の記述がないか（あれば差分だけを提案に絞る）
4. **恒久性** — 一時的な障害・特定バージョン限定のバグではないか

結果はIssueコメントとして投稿し、末尾にマーカーを付ける。

- 全件または一部が承認: `<!-- shared-knowledge-verdict:approved -->`
- 全件却下: `<!-- shared-knowledge-verdict:rejected -->`

一部承認の場合は、コメント本文でどの提案を承認しどれを却下したか（理由つきで）明記する。
判定は共有知識を**汚さない方向に倒す**（迷ったら却下し、アプリ固有として残すよう促す）。

### 9.3 反映（`shared-knowledge-propose.yml`）

develop向けPRがマージされた時点で起動し、以下を行う。

1. ブランチ名`issue-<番号>`から対応Issueを特定する（規約外のブランチは対象外）
2. Issueコメントに`<!-- shared-knowledge-proposal -->`と
   `<!-- shared-knowledge-verdict:approved -->`が**両方**あることを確認する。片方でも欠ければ
   何もせず終了する
3. 共有知識リポジトリを`.shared-context/`へcheckoutする（`WORKFLOW_PAT`）
4. Claude Codeが、承認された提案だけを該当ファイルへ追記し、
   `knowledge/issue-deck-<Issue番号>`ブランチを作成して`m-guchi/docs`へPull Requestを作成する
5. 作成したPRのURLを対応Issueへコメントする
6. PRもコメントも確認できない場合は、フォールバックコメントを投稿する（このリポジトリの他の
   ワークフローと同じ、機械的な検証ステップによる安全網）

**共有知識リポジトリのデフォルトブランチへ直接pushすることはしない。** 反映は常にPR経由で、
最終的なマージは人間が行う。これにより、実装エージェントの誤判定・レビューエージェントの
誤承認のいずれが起きても、人間のマージ操作という第3の関門で止められる。

### 9.4 汚染を防ぐための3重のガード

| ガード | 内容 |
|---|---|
| 1. 書き込み経路の分離 | 実装エージェントには共有知識リポジトリへの書き込み手段を与えない（`.shared-context/`は`.gitignore`済み・読み取り専用。Actionsのcheckoutも`persist-credentials: false`） |
| 2. 審査 | レビューエージェントが4観点で審査し、承認マーカーが無い提案は反映ワークフロー自体が起動しない |
| 3. 人間のマージ | 反映は必ず`m-guchi/docs`へのPRとして提示され、マージは人間が行う |

さらに、共有知識リポジトリへの変更は常に「1 Issue = 1 PR」になるため、後から`git log`で
「どの知見がどのIssueで、どういう根拠で入ったか」を追跡できる。

## 10. 実装エージェント・レビューエージェントの役割分担

| 項目 | 実装エージェント | レビュー・統合エージェント |
|---|---|---|
| 起動 | Issueへの`@claude`コメント（`claude-issue-dispatch.yml`） | develop向けPRの作成・更新（`claude-review-develop.yml`） |
| 共有知識 | **読む**（`.shared-context/agent-rules/implementation.md`→必要な`knowledge/`） | **読む**（`.shared-context/agent-rules/review.md`→必要な`knowledge/`） |
| Issue理解・コード調査 | ✅ | 差分の読解のみ |
| 実装・テスト・PR作成 | ✅ | ❌（コードの直接修正は禁止） |
| アプリ固有知見の記録 | ✅ 実装PRに同梱して`docs/`へ書く | 記録内容の妥当性を確認する |
| 共有知識の提案 | ✅ 提案コメントを投稿する（書き込みはしない） | ❌ |
| 共有知識の審査 | ❌ | ✅ 4観点で審査し承認/却下マーカーを付与する |
| 共有知識リポジトリへの書き込み | ❌ | ❌（`shared-knowledge-propose.yml`がPRを作成し、人間がマージする） |
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
- **提案フォーマットの機械検証はしていない。** `shared-knowledge-propose.yml`はマーカーの存在
  チェックのみを機械的に行い、YAMLブロックの解釈はClaude Codeに委ねている。フォーマット崩れが
  頻発するようであれば、スキーマ検証ステップの追加を検討する。
- **他リポジトリへの展開時はPATの到達性確認が要る。** issue-deckの`WORKFLOW_PAT`はAll repositories
  のため追加設定は不要だが、共有知識リポジトリがprivateである限り、リポジトリを個別指定した
  PATを使う導入先ではRepository accessの更新が必要になる。

## 関連ドキュメント

- [docs/multi-agent-workflow.md](multi-agent-workflow.md) — issue-deck自身のマルチエージェント運用の設計
- [docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md) — 他リポジトリへの導入手順
- [docs/cross-repo-automation.md](cross-repo-automation.md) — 展開方式の調査・比較
- [CLAUDE.md](../CLAUDE.md) — issue-deckの運用ルール本体
