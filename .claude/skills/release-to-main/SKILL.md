---
name: release-to-main
description: issue-deckでdevelopからmainへリリースPRを作成・マージする手順。バージョン番号の更新（package.json）、developブランチ保護（CI必須のためフィーチャーブランチ+PR経由が必要）、squash mergeによる祖先切れの回避（マージコミット必須）、develop→mainのPRがCLAUDE.mdの自動マージ不可カテゴリに該当する運用を定める。「developをmainへリリースして」「develop→mainのPRを作って」「バージョンを上げてmainに反映して」といったタスクでは必ず参照する。
---

# develop→mainリリース手順（issue-deck）

## 0. ローカルのdevelopを最新化する

リリース作業はブランチの祖先関係に敏感なため、ローカルの`origin/develop`が実際のリモートより古いまま作業を始めない。`git status`で`behind`と出ていたり、`git rev-parse origin/develop`と`gh api repos/guchi-apps/issue-deck/branches/develop -q .commit.sha`が一致しない場合はズレている。

`git fetch`はgit-github-jaスキルの運用（明示的指示があるまで実行しない）の対象のため、ズレを検知したらユーザーに一言断ってから`git fetch origin`する。

## 1. バージョンを上げる

- `package.json`の`version`を更新する（変更内容に応じてpatch/minorを判断。迷う場合はユーザーに確認する）
- コミットメッセージは`vX.Y.Zをリリースする。`
- Author はClaude Code（git-github-jaスキル参照）
- リリースブランチ名は`release/vX.Y.Z`で統一する（過去に`release-v0.5.2`のようなハイフン区切りも使われたことがあるが、スラッシュ区切りに統一する）

## 2. developへの反映はフィーチャーブランチ+PR経由で行う

`develop`ブランチには**直接push不可**（`lint-and-build`ステータスチェック必須のブランチ保護がかかっている）。以下の手順を踏む。

1. 変更用のフィーチャーブランチを作成してpush
2. `develop`向けにPRを作成（`gh pr create --base develop --head <branch>`）
3. CI通過を確認し、ユーザーにマージを依頼する（自己マージしない）

developへの直接コミットを試みると`GH013: Repository rule violations`でpushが拒否される。もし誤って`develop`にローカルコミットしてしまった場合は、コミットを新しいブランチへ退避し、`develop`は`origin/develop`にリセットしてからPRを作り直す。

## 3. develop→mainのPRを作成する

**headは`develop`ではなく、リリース内容を凍結した固定ブランチ`release-main/vX.Y.Z`にする**（#2117）。

```bash
# バンプ用PRがdevelopへマージされたコミット（そのマージコミットの第2親＝バンプブランチの先端）で凍結する
git push origin "<バンプブランチの先端SHA>:refs/heads/release-main/vX.Y.Z"
gh pr create --base main --head "release-main/vX.Y.Z" --title "vX.Y.Zをmainへリリースする"
```

- PR本文には対象Issue・含まれる主な変更・注意点（Secrets/DBマイグレーション等の有無）・Test planを記載する
- **`## 対象issue`の見出しに`- #<番号> <タイトル>`の形で列挙する。** マージ時にこの一覧を読んで
  issueを`Done`にしてcloseする（`reusable-issue-labels.yml`の`main-pr-merged`）
- **develop→mainのマージは自動マージ不可カテゴリに該当する**（CLAUDE.md記載）。CI通過後、必ずユーザーに確認を取ってからマージする（自己マージしない）

### なぜheadを`develop`にしないか

PRのheadは常にそのブランチの先端を追う。`develop`をheadにすると、**PRを作った後にdevelopへ
マージされた変更まで同じリリースでmainへ出る**。それらは更新履歴にも対象issue一覧にも載って
いないため、「何が本番へ出たのか」がPRの内容と食い違う。固定ブランチにしておけば、リリースPRを
作った後のdevelopへのマージは次のリリースへ回る。

このPRのCIが落ちた場合、**`release-main/vX.Y.Z`を直接直さない。** そのブランチはマージ時に
削除されるため、修正がmainにだけ残りdevelopから消える。developで直したうえで、このPRをcloseして
リリースを起動し直す（新しい凍結ブランチが作られる）。

なお1〜3は`.github/workflows/release-develop-to-main.yml`が自動化している。手で行うのは、
その自動化が使えないときだけ。

## 4. マージ方式は「マージコミット」を使う（squash mergeは厳禁）

**重要**: develop→mainのPRを**squash mergeでマージすると、developとmainの祖先のつながりが切れる**。

### 何が起きるか

squash mergeすると、mainの新しいコミットはdevelopのどのコミットとも親子関係を持たない単独コミットになる。次にdevelop→mainのPRを作ると、gitが計算する共通祖先（merge-base）が実際より大きく過去に遡ってしまい、**両ブランチで内容が同一のファイルでも3-way mergeが見かけ上コンフリクトする**。

この問題は実際に2回発生している。

- PR #56（v0.4.0, squash merge）→ PR #86（v0.5.0）でコンフリクト発生 → PR #87で祖先を修復
- PR #86（v0.5.0, squash merge）→ PR #90（v0.5.1）でコンフリクト再発 → PR #91で再修復

### 対処法（祖先の再修復）

もし見かけ上のコンフリクトが発生したら、以下の手順で内容を変えずに祖先のつながりだけを修復する。

```bash
git checkout -b sync-main-ancestry-N origin/develop
git merge -s ours origin/main -m "mainの履歴をdevelopに合流させ、祖先のつながりを修復する。"
git push -u origin sync-main-ancestry-N
gh pr create --base develop --head sync-main-ancestry-N --title "mainとdevelopの祖先のつながりを修復する"
```

- マージ前に`git diff origin/main origin/develop`で実質差分がないこと（＝mainに独自変更がないこと）を必ず確認する
- このPR自体はファイル差分ゼロになるはずなので、diffがあれば別途調査する
- **このPRも含め、developへのマージ・develop→mainのマージは常にマージコミット方式で行う**（GitHubのマージボタンで「Create a merge commit」を選ぶ。「Squash and merge」は選ばない）
