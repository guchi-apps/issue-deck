---
name: release-to-main
description: issue-deckでdevelopからmainへリリースPRを作成・マージする手順。バージョン番号の更新（package.json）、developブランチ保護（CI必須のためフィーチャーブランチ+PR経由が必要）、squash mergeによる祖先切れの回避（マージコミット必須）、develop→mainのPRがCLAUDE.mdの自動マージ不可カテゴリに該当する運用を定める。「developをmainへリリースして」「develop→mainのPRを作って」「バージョンを上げてmainに反映して」といったタスクでは必ず参照する。
---

# develop→mainリリース手順（issue-deck）

## 0. ローカルのdevelopを最新化する

リリース作業はブランチの祖先関係に敏感なため、ローカルの`origin/develop`が実際のリモートより古いまま作業を始めない。`git status`で`behind`と出ていたり、`git rev-parse origin/develop`と`gh api repos/m-guchi/issue-deck/branches/develop -q .commit.sha`が一致しない場合はズレている。

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

- `gh pr create --base main --head develop --title "vX.Y.Zをmainへリリースする"`
- PR本文には対象Issue・含まれる主な変更・注意点（Secrets/DBマイグレーション等の有無）・Test planを記載する
- **develop→mainのマージは自動マージ不可カテゴリに該当する**（CLAUDE.md記載）。CI通過後、必ずユーザーに確認を取ってからマージする（自己マージしない）

バージョンbump前にこのPRを先に作ってしまっていた場合は、作り直す必要はない。1〜2のバージョンbump用PRがdevelopへマージされれば差分は自動的にこのPRへ反映されるので、マージ後にタイトルを`vX.Y.Zをmainへリリースする`へ更新すればよい。

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
