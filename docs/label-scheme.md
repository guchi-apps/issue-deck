# 共通GitHubラベル体系と一括同期（#3237）

guchi-apps配下の全リポジトリで共通利用するGitHubラベルの、**正本・旧名との対応・配り方**をまとめる。
各ラベルを付ける・外すタイミングと番号帯の設計判断は[multi-agent/labels.md](multi-agent/labels.md)、
新規リポジトリへの導入手順の全体は[cross-repo-setup-guide.md](cross-repo-setup-guide.md)「2. ラベル体系」を参照。

## 正本と同期スクリプト

| 何 | どこ |
|---|---|
| ラベルの名前・説明・色、旧名から新名への対応 | [`.github/labels.json`](../.github/labels.json)（**唯一の正本**） |
| 全リポジトリへ冪等に配るスクリプト | [`scripts/sync-labels.sh`](../scripts/sync-labels.sh) |
| 正本の整合と「旧名がリポジトリに残っていない」ことの検査 | [`src/lib/labels-manifest.test.ts`](../src/lib/labels-manifest.test.ts) |

**色はカテゴリ単位で統一する**（問題・調査`b60205`／機能変更`0052cc`／保守・開発基盤`bfdadc`／進行・判断`5319e7`／
優先度`fbca04`／クローズ理由`c5def5`）。自動実行・確認フロー用の`00.`〜`25.`は従来の色のまま。

## 体系

| 帯 | ラベル | 意味 |
|---|---|---|
| `00.`・`01.`・`11.`・`21.`〜`25.` | `00.check-user`・`01.check-*`・`11.local`・`21.plan-required`・`22.merge-confirm-required`・`23.preview-required`・`25.artifact-required` | 自動実行・確認フロー用（**名前・挙動とも不変**） |
| `30.`〜`49.` 問題・調査 | `30.bug`・`31.security`・`40.investigation`・`41.cannot-reproduce` | 不具合・セキュリティ・調査・再現待ち |
| `50.`〜`59.` 機能変更 | `50.feature`・`51.improvement`・`52.performance`・`53.accessibility`・`54.data-migration`・`55.integration` | 追加・改善・性能・操作性・移行・外部連携 |
| `60.`〜`69.` 保守・開発基盤 | `60.chore`・`61.ops`・`62.design`・`63.refactor`・`64.test`・`65.docs`・`66.dependencies` | 保守作業 |
| `70.`〜`79.` 進行・判断 | `70.needs-decision`・`71.manual-step`・`72.blocked`・`73.needs-info`・`74.needs-spec`・`75.agent-ready` | 判断待ち・手作業・進行不能・情報不足・要件不足・着手可 |
| `80.`〜`89.` 優先度 | `80.Priority: High`・`85.Priority: Medium`・`89.Priority: Low` | `85`は付いていないのと同じ「通常」 |
| `90.`〜`99.` クローズ理由 | `90.Close: another`・`91.Close: duplicate`・`92.Close: invalid`・`93.Close: cannot-reproduce`・`94.Close: wontfix`・`95.Close: obsolete`・`96.Close: completed` | closeの理由 |

説明文は`.github/labels.json`を見る（GitHubの上限100文字以内）。

**issue-deckの画面・自動判定での扱い**

- 「クローズする」のメニューには`96.Close: completed`を除く6種を出す（`state_reason`が`not_planned`のクローズ用のため）
- Claudeによるラベル自動付与の対象は30〜89番台。ただし**状態を表す`41`・`71`〜`75`は外す**
- ブランチ画面の優先度は`80`（高）・`89`（低）だけを読む。`85`は付いていないのと同じ

## 旧名との対応

| 旧名 | 新名 | 移し方 |
|---|---|---|
| `40.unexpected` | `40.investigation` | 改名 |
| `70.confirm` | `70.needs-decision` | 改名 |
| `89.Priority: low` | `89.Priority: Low` | 改名（大文字小文字のみの違い） |
| `90.Close: duplicate` | `91.Close: duplicate` | 改名 |
| `90.Close: invalid` | `92.Close: invalid` | 改名。**再現できずに閉じたものの`93.Close: cannot-reproduce`への振り分けは自動では行わない**（本文・コメントを読まないと分からないため、必要なら人が付け替える） |
| `90.Close: wonfix` | `94.Close: wontfix` | 改名（誤字の訂正） |

`.github/labels.json`の`renames`がこの対応の機械可読な版で、スクリプトはそれを読む。旧名を参照するコード・
プロンプト・docsが残っていないことは`labels-manifest.test.ts`が確かめる（この対応表と正本、同期スクリプトの
テストだけが旧名を書いてよい）。

## 同期の手順

```bash
scripts/sync-labels.sh dry-run                       # 全リポジトリの変更対象と件数（何も書かない）
scripts/sync-labels.sh apply                         # 反映する
scripts/sync-labels.sh apply --repo my-app           # 1リポジトリだけ
```

- **対象は`gh repo list <org>`の非アーカイブ全件**（privateを含む。直近pushの有無では落とさない）。
  アーカイブ済みは変更せずスキップとして一覧に出す
- **改名はGitHubのrename APIで行うため、既存Issue・PRへの付与（open・closedとも）は維持される。**
  新名が既にあるときだけ、旧ラベルのIssue・PRを新名へ付け替えてから旧ラベルを削除する
  （付け替えに1件でも失敗したら旧ラベルは消さず、そのリポジトリを失敗として数える）
- 一部のリポジトリで失敗しても残りを処理し、最後に**成功（変更あり／なし）・スキップ・失敗の一覧**を出す
  （失敗があれば終了コード1）
- **正本にも旧名にも無いラベルは削除せず報告だけ**する（GitHub既定の`bug`・`enhancement`等が残る。
  消すなら内容を確かめて`gh label delete`で個別に）
- 再実行しても差分・重複ラベルは出ない。**反映後はもう一度`dry-run`を流し、全リポジトリが「変更なし」に
  なることで完了を確かめる**

### 実行者と順序

- **`apply`は全リポジトリのラベルを書き換える外向きの操作**。必ず`dry-run`の件数を見てから流す。
  ユーザー本人のトークンで動くローカルセッション（またはサブPCの端末）で行う
- **旧名を参照するコードとプロンプトの反映との間に窓ができる。** 各リポジトリの無人実行プロンプトは
  `prompts-ref`のタグ経由で配られるため、`apply`で`70.confirm`を改名してから新しいタグ
  （`workflows/vN`）を配り終えるまでの間、他リポジトリの無人実行が古いプロンプトのまま
  `--label "70.confirm"`で起票しようとして失敗し得る。順序は「`apply`→develop→mainのリリース→
  画面の「新しいタグを切って配る」」とし、窓を短くする
- AIDEの`aide_create_issue`が既定で付ける`70.confirm`は、改名後は`70.needs-decision`へ変える必要がある
  （`guchi-apps/aide`側の別Issue）

## 新規リポジトリへ同じラベルセットを適用する

1. **画面の「新規アプリを立ち上げる」を通した場合は、作成時にissue-deckの現在のラベルが写される**
   （`cloneRepositoryLabels`。GitHub既定ラベルは消える）。手作業は要らない
2. 導線を通さずに作ったリポジトリは、issue-deckのチェックアウトで次を流す。

   ```bash
   scripts/sync-labels.sh dry-run --repo <リポジトリ名>
   scripts/sync-labels.sh apply   --repo <リポジトリ名>
   scripts/sync-labels.sh dry-run --repo <リポジトリ名>   # 「変更なし」になることを確認
   ```

## ラベルを足す・直す

1. **`.github/labels.json`を先に直す**（名前・色・説明。改名は`renames`へ`from`→`to`を足す）
2. `labels-manifest.test.ts`と`scripts/sync-labels.test.mjs`が通ることを確かめ、名前を参照するコード・docsを追従させる
3. `scripts/sync-labels.sh dry-run`で件数を見てから`apply`する
4. **ラベルを個別のリポジトリだけで直さない。** その場は揃っても正本との差が残り、次の同期で上書きされる

`renames`のエントリは、全リポジトリで改名が済んだ後も残しておいてよい（旧名が無ければ何もしない）。
消すと、まだ旧名を持つ取りこぼしのリポジトリを次の同期で直せなくなる。
