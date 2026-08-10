# Organization移行 実施チェックリスト

**いつ読むか**: `m-guchi`から`guchi-apps`へのリポジトリ移行を実際に進めるとき。

なぜ移行するのか・費用・ロールバック策といった判断の背景は
[organization-migration.md](organization-migration.md)を参照。こちらは手を動かす順番だけを扱う。

作業中は上から順に潰していく。**Aのトークン整備が全体のボトルネック**で、ここが済むまで
org配下へ移したリポジトリのワークフローは動かない。

## マージ待ちのPull Request

いずれもワークフローファイルの変更にあたるため、自動マージ対象外。人手で確認・マージする。

| PR | 内容 |
|---|---|
| guchi-apps/issue-deck#999 | issue-deckとdocsの参照先を`guchi-apps`へ書き換え（手順C） |
| guchi-apps/shopping-list#90 | 再利用可能ワークフローの参照先を`guchi-apps`へ書き換え（手順D） |
| guchi-apps/dayspan#117 | 同上（手順D） |

**残っている確認項目（手順C末尾・手順D末尾）は、いずれもこの3件のマージが前提。**

## 完了済み

- [x] Organization `guchi-apps` を作成
- [x] GitHub App（本番）の所有権を`guchi-apps`へ移管
- [x] Appを`guchi-apps`へインストール（All repositories）
- [x] `uptime-kuma`をtransfer
- [x] `docs`をtransfer
- [x] org variable `SHARED_CONTEXT_REPO = guchi-apps/docs`（All repositories）を登録

## A. トークン整備

ここが済むまで、org配下のリポジトリはワークフローが動かない。最優先。

- [x] 開発App `issue-deck-dev`（App ID 4445268）も`guchi-apps`へ移管する（プレビュー環境が使用）
- [x] **Claude Code GitHub App（<https://github.com/apps/claude>）を`guchi-apps`へインストールする**

      `anthropics/claude-code-action`が使うAnthropic提供のサードパーティAppで、IssueDeckの
      自作App（本番・`issue-deck-dev`）とは**別物**。他人のAppなので所有権移管ではなく、
      org側へ新規インストールする。対象リポジトリの選択も必要。

      未インストールだと、Claudeを動かす全ワークフロー（`claude-review-develop.yml`・
      `reusable-issue-dispatch.yml`・`claude-ci-fix.yml`・`claude-conflict-resolve.yml`）が
      次のエラーで失敗する。

      ```
      App token exchange failed: 401 Unauthorized
      Claude Code is not installed on this repository.
      ```

      guchi-apps/issue-deck#999 で実際に発生した（`claude-review`ジョブが失敗。
      必須チェックは`lint-and-build`のみのためマージ自体はブロックされないが、
      自動レビューが効かなくなる）。
- [x] 本番AppのApp ID・slug・Client ID・Webhook URLが移管の前後で変わっていないことを確認する
  - [x] 変わっていた場合、1Passwordの`apps/issue-deck`（`github-app-id`・
        `github-app-private-key-base64`・`github-app-slug`）と本番`.env`を更新する
- [x] 新しいFine-grained PATを発行する（<https://github.com/settings/personal-access-tokens/new>）
  - [x] **Resource owner = `guchi-apps`**（既定は個人アカウントのまま。必ず切り替える）
  - [x] Repository access = **All repositories**
  - [x] Contents / Issues / Pull requests / Actions = **Read and write**
  - [x] **Workflows = Read and write**（`.github/workflows/`配下へpushするために必須）
  - [x] Expiration を控える（最長366日）
- [x] 1Passwordの`apps/issue-deck`へ保存する
- [x] issue-deckの`FineGrainedToken`台帳へ有効期限を登録する
- [x] org secretを登録する（<https://github.com/organizations/guchi-apps/settings/secrets/actions>、
      Repository access = All repositories）
  - [x] `WORKFLOW_PAT` = 上で発行した新しいPAT
  - [x] `CLAUDE_CODE_OAUTH_TOKEN` = 既存と同じ値

> org secretは`guchi-apps`配下のリポジトリにしか効かない。`m-guchi`に残っている間は
> 従来のrepo secretで動き続けるので、先に登録しておいて問題ない。
>
> `OP_SERVICE_ACCOUNT_TOKEN`はorg化しない。private 4件を含む15リポジトリが使っており、
> GitHub Freeではorg secretをprivateリポジトリから参照できないため。transferで各リポジトリに
> 引き継がれるので、今回の移行では触らなくてよい。

## B. transfer済みリポジトリの後始末

- [x] `git -C ~/apps/_docs remote set-url origin github:guchi-apps/docs.git`
      （ディレクトリ名`_docs`とリポジトリ名`docs`が違う点に注意）
- [x] `~/apps/uptime-kuma`のremoteを更新する。**このリポジトリだけremote名が`origin`ではなく
      `oriorigin`**（過去のタイプミス）なので、ついでに直す

      ```bash
      git -C ~/apps/uptime-kuma remote rename oriorigin origin
      git -C ~/apps/uptime-kuma remote set-url origin github:guchi-apps/uptime-kuma.git
      ```

> ローカルクローンのremoteは次のコマンドで一括確認できる。`~/apps/<repo>-worktrees/`配下は
> 本体と`.git/config`を共有するため、確認・更新の対象外でよい。
>
> ```bash
> for d in ~/apps/*/; do n=$(basename "$d"); case "$n" in *-worktrees) continue;; esac
>   git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
>   printf "%-20s %s\n" "$n" "$(git -C "$d" remote -v | head -1)"
> done
> ```
>
> 2026-08-11時点でローカルクローンがあるのは18件。`gucchii-os`・`pi0w_260719`・
> `sensor_260218`・`sensor_260531`はローカルに無いため、transfer後のremote更新は不要。

## C. issue-deckのtransfer

**順序に注意。transfer → コード修正 の順で行う。** 先に`guchi-apps/issue-deck`へ書き換えると、
まだ存在しないリポジトリを指すことになり`scripts/start-issue.sh`等が壊れる。

- [x] transferする

      ```bash
      gh api -X POST /repos/m-guchi/issue-deck/transfer -f new_owner=guchi-apps
      ```

- [x] 引き継ぎを確認する

      ```bash
      gh secret list   --repo guchi-apps/issue-deck
      gh variable list --repo guchi-apps/issue-deck
      gh api /repos/guchi-apps/issue-deck/branches/develop/protection \
        --jq '.required_status_checks.contexts'
      ```

- [x] **repo secretの`WORKFLOW_PAT`を削除する**

      ```bash
      gh secret delete WORKFLOW_PAT --repo guchi-apps/issue-deck
      ```

      > **repo secretはorg secretを上書きする**（GitHub Docs
      > [Secrets reference](https://docs.github.com/en/actions/reference/security/secrets):
      > "If a secret with the same name exists at multiple levels, the secret at the lowest level
      > takes precedence"）。transferで引き継がれた古いPATが残っていると、Aで登録した
      > 新しいorg secretが効かず、org配下へ届かないPATを使い続けて失敗する。

- [x] repo secretの`CLAUDE_CODE_OAUTH_TOKEN`を削除する（同上）
- [x] `OP_SERVICE_ACCOUNT_TOKEN`は**残す**（org化していないため）
- [x] ローカルremoteを更新する（linked worktreeは`.git/config`を共有するので1回でよい）

      ```bash
      git -C ~/apps/issue-deck remote set-url origin github:guchi-apps/issue-deck.git
      ```

- [x] コード修正のPRを作成する
  - [x] `.github/workflows/reusable-issue-dispatch.yml:708` → `repository: guchi-apps/issue-deck`
  - [x] `scripts/check-label-diff.sh:6` → `SOURCE_REPO="guchi-apps/issue-deck"`
  - [x] `scripts/start-issue.sh:64` → `--repo guchi-apps/issue-deck`
  - [x] `scripts/start-reviewer.sh:48` → `--repo guchi-apps/issue-deck`
  - [x] `.claude/skills/release-to-main/SKILL.md:10` → `repos/guchi-apps/issue-deck/...`
  - [x] ワークフローの既定値5箇所を`m-guchi/docs` → `guchi-apps/docs`へ
        （`reusable-issue-dispatch.yml:687`・`claude-review-develop.yml:226`・
        `shared-knowledge-propose.yml:128/221/298`）。org variableが読めない環境で
        古い参照へ静かに落ちるのを防ぐ保険
  - [x] 表示のみのドキュメント参照（`docs/cross-repo-setup-guide.md:74/87/115/123`・
        `docs/supported-repositories.md`・`docs/shared-knowledge.md:279/383`）
- [x] ブランチ保護を確認し、無ければ付与する（`main`が無保護だったため`lint-and-build`を付与）
- [x] CI・deploy・issue-labelsが通ることを確認する

      guchi-apps/issue-deck#999 で以下が実地で確認できた。

      - ラベル遷移（`wip-on-push` → `develop-pr-opened`）
      - `claude-code-action`（Claude Code Appのインストール後。それまでは401で失敗）
      - `risk-check`によるワークフロー変更の検知と`00.check-user`の付与
      - `auto-merge`のスキップ判定（「対応Issue #996 に 00.check-user が付与されているため、
        自動マージをスキップします。」）
      - 必須チェック`lint-and-build`とブランチ保護

- [ ] **共有知識のcheckoutが通ることを確認する**（新PATが効いているかの実質的な検証）

> issue-deckが`m-guchi`にある間は、共有知識のcheckoutは失敗したままになる。
> `WORKFLOW_PAT`はsecret 1つしか無く、`m-guchi/issue-deck`自身への操作と
> `guchi-apps/docs`の読み取りを1本のPATで両立できないため。`continue-on-error`で
> 停止はしないので、このtransferまで放置してよい。

## D. shopping-list / dayspanのtransfer

issue-deckより後に行う。caller側の`uses:`更新が必要なため。

- [x] `shopping-list`をtransfer → repo secret（`WORKFLOW_PAT`・`CLAUDE_CODE_OAUTH_TOKEN`）削除
      → remote更新
- [x] `dayspan`をtransfer → repo secret（同上）削除 → remote更新
- [x] `shopping-list`・`dayspan`のブランチ保護を確認し、無ければ付与する
      （実際にdevelop・mainとも無保護だったため付与。詳細はE節の注記）
- [x] caller の`uses:`計4箇所のownerを`guchi-apps`へ書き換える（タグはそのままでよい）
      → guchi-apps/shopping-list#90・guchi-apps/dayspan#117（**マージ待ち**）
  - [x] `shopping-list/.github/workflows/issue-labels.yml:34`（`@workflows/v1`）
  - [x] `shopping-list/.github/workflows/claude-issue-dispatch.yml:46`（`@workflows/v6`）
  - [x] `dayspan/.github/workflows/issue-labels.yml:33`（`@workflows/v6`）
  - [x] `dayspan/.github/workflows/claude-issue-dispatch.yml:37`（`@workflows/v6`）
- [ ] 両リポジトリでワークフローが通ることを確認する（上記PRのマージ後）
  - [ ] `issue-<番号>`ブランチへのpushで`issue-labels.yml`が発火し`02.wip`が付くこと
  - [ ] Issueへの`@claude`コメントで`claude-issue-dispatch.yml`が起動すること

> 上記PRは`chore/org-migration-refs`というIssue紐付けの無いブランチ名にしたため、
> `identify-issue`がIssueを特定できず`auto-merge`がスキップされる
> （「対応Issue番号を特定できないため、自動マージをスキップします。」）。
> ワークフロー変更なので人手でマージするのが適切であり、これは意図した状態。

## E. 残りのリポジトリのtransfer

各リポジトリ共通で「transfer → ローカルremote更新 → issue-deckの画面に出るか確認」を行う。
ワークフローを持たないものはそれだけでよい。

publicアプリ:

- [ ] `car-care`
- [ ] `asset-manager`
- [ ] `subscription-lists`（repo secretの`CLAUDE_CODE_OAUTH_TOKEN`を削除する）
- [ ] `gucchii-os`
- [ ] `meisai-lab`
- [ ] `myroom`
- [ ] `portfolio`
- [ ] `signaly`
- [ ] `solitaire`
- [ ] `wifi-speed`

private:

- [ ] `vps`
- [ ] `ops-dashboard`
- [ ] `db-console`
- [ ] `clip-hive`
- [ ] `pi0w_260719`
- [ ] `sensor_260218`
- [ ] `sensor_260531`

> privateリポジトリはFree organizationではブランチ保護が使えない。マルチエージェント運用へ
> 載せる際は、最後のマージを手動にする（`auto-merge-fallback`ジョブ経由）。

> **transfer後はブランチ保護を必ず確認する。** `shopping-list`ではdevelop・mainとも保護が
> 無い状態になっていた（`issue-deck`のmainも同様）。`dayspan`は残っていたため、transferで
> 必ず消えるわけではないが、消えることがある。保護が無いと`gh pr merge --auto`が成立せず、
> `claude-review-develop.yml`のauto-mergeが機能しなくなる（毎回手動マージになる）。
>
> ```bash
> for b in develop main; do
>   gh api /repos/guchi-apps/<repo>/branches/$b/protection \
>     --jq '.required_status_checks.contexts' 2>/dev/null || echo "$b: 保護なし"
> done
> ```
>
> 付与するときは必須チェック名を対象リポジトリのCIジョブ名に合わせる
> （issue-deck・dayspanは`lint-and-build`、shopping-listは`lint`）。`ci.yml`の
> `pull_request.branches`に対象ブランチが含まれていることも確認する。含まれないと
> 必須チェックが永久に埋まらずマージ不能になる。
>
> ```bash
> jq -n '{required_status_checks:{strict:false,contexts:["<ジョブ名>"]},
>         enforce_admins:false, required_pull_request_reviews:null, restrictions:null,
>         allow_force_pushes:false, allow_deletions:false}' \
>   | gh api -X PUT /repos/guchi-apps/<repo>/branches/<branch>/protection --input -
> ```

## F. 仕上げ

- [ ] issue-deckの画面で再同期し、リポジトリ一覧とIssue件数が移行前と一致することを確認する
      （`POST /api/sync/repositories`・`POST /api/sync/issues`）
- [ ] どれか1つのIssueにラベルを付け、Webhookが新しいownerからも届いて画面へ反映されることを確認する
- [ ] 取りこぼしを確認する

      ```bash
      grep -rn "m-guchi/" --include="*.md" --include="*.yml" --include="*.sh" . | grep -v node_modules
      ```

- [ ] `docs/supported-repositories.md`のリポジトリ名を更新する
- [ ] archivedな大学系7件（thesis系・tyuujitu系）は個人アカウントに残す
      （Appが`guchi-apps`所有のprivateになるためissue-deckには表示されなくなるが、
      運用対象ではないため支障はない）
- [ ] このチェックリストと[organization-migration.md](organization-migration.md)の
      「実施状況」を最終状態へ更新する
