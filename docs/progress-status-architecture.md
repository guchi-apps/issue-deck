# 進捗管理をGitHub Projectsへ移す設計

**いつ読むか**: Issueの進捗（未着手〜本番反映済）の扱いに関わるコードを触るとき。
`01.planning`〜`09.main`のラベルとProject Statusのどちらを見るべきか迷ったとき。

issue #991 の設計ドキュメント。**この文書が進捗管理の設計の一次情報源**で、各段階のIssueは
ここを参照する（Issue側に設計を複製しない）。

## 背景

issue-deckはIssueの進捗を`01.planning` → `02.wip` → `03.d:marge` → `05.develop` →
`07.m:marge` → `09.main`のラベルで管理してきた。#991は「GitHub Projectsのカンバンで
同じことができないか」という検討で、当初は`m-guchi`がUserアカウントだったため
`projects_v2_item` Webhookが使えず（Organization限定）実現に無理があった。

#996 でOrganization `guchi-apps`への移行が完了し、GitHub Appのインストールトークンで
Projects v2を読み書きできるようになったため前提が整った（経緯は
[organization-migration.md](organization-migration.md)）。

## 決定事項

議論の結果、以下を最終形とする。**この4点が各段階の設計を規定する。**

1. **進捗ラベル（`01.planning`〜`09.main`）は最終的に廃止する。** Statusを唯一の正にする
2. **対象はマルチエージェント対応リポジトリ全体。** `shopping-list`・`dayspan`も同じProjectで管理する
3. **実行基盤はGitHub ActionsとミニPC上のClaude Codeを併用する。** ローカル実行の主目的は
   セッションの保持
4. **privateアプリを統合する段階でGitHub Team（$4/月）へ上げる**

`00.check-user`・`21.plan-required`・`22.merge-confirm-required`・`23.preview-required`・
`24.screenshot-required`・`70.confirm`・`11.local`・Priority系は**ラベルのまま残す**。
Status = 今どこにいるか、Label = どんな性質・条件があるか、という役割分担にする。

### StatusとラベルとProgressStatusKeyの対応

| Project Status | 進捗ラベル | `ProgressStatusKey` |
|---|---|---|
| Ready | （進捗ラベル無し） | `ready` |
| Planning | `01.planning` | `planning` |
| Implementation | `02.wip` | `implementation` |
| Develop PR | `03.d:marge` | `develop-pr` |
| Develop | `05.develop` | `develop` |
| Release | `07.m:marge` | `release` |
| Done | `09.main` | `done` |

対応表の実体は[`src/lib/issue-progress.ts`](../src/lib/issue-progress.ts)の`PROGRESS_STATUSES`
にあり、Status名・ラベル名・表示名・アイコンを1箇所に集約している。

## 目標アーキテクチャ

```
        人間（カンバンをドラッグ / issue-deckのボタン）
                      │
                      ▼
        GitHub Projects（Status = 進捗の唯一の正）
              ▲                    │
   ② Statusを更新                  │ ③ projects_v2_item Webhook
      （Appトークン）               ▼
        ┌──────────  issue-deck  ──────────┐
        │       状態の唯一の出入口            │
        │  ①報告を受ける      ④ジョブを配る   │
        └────▲──────────────────┬──────────┘
             │                  │
    ┌────────┴────────┬─────────┴────────┐
    │  GitHub Actions │  ミニPC           │
    │  claude-code-   │  Claude Code      │
    │  action         │  （セッション保持） │
    └─────────────────┴───────────────────┘
```

### 中核の判断：Projectへの読み書きはissue-deckに一本化する

実行基盤が直接Projectを更新するのではなく、**issue-deckのAPIへ報告し、issue-deckがProjectを
書く**。理由は3つ。

- **権限の配布が1箇所で済む。** Projects v2の書き込み権限を持つのはissue-deckのGitHub Appだけで
  よく、他リポジトリのワークフローにもミニPCにも配らない。対象リポジトリが増えても増えるのは
  「issue-deckのAPIを叩く」ことだけ
- **人間の操作と機械の更新を区別できる。** Projectを書くのが常にissue-deckのAppなので、
  `projects_v2_item`の`sender`が自分なら無視できる。これがPhase 3で「自分の書き込みで自分が
  起動する」のを防ぐ唯一の手段になる。各ワークフローが`WORKFLOW_PAT`（所有者は人間の`m-guchi`）
  で直接書くと、人間のドラッグと見分けがつかず成立しない
- **実行基盤を差し替えられる。** ミニPC側も同じAPIへ報告すればよく、Projectsの認証を持たせずに
  済む。#991のコメントにある`ExecutionProvider`の実体がこのAPIになる

**前例がある。** `reusable-issue-dispatch.yml`は既に`$APP_BASE_URL/api/settings/claude-model`を
curlで叩き、疎通失敗時は警告を出してフォールバックする作りになっている。同じ流儀を使う。

### 受け入れるリスク

- **issue-deckが進捗更新の単一障害点になる。** 呼び出し側は失敗してもワークフローを止めない。
  ズレは再同期で是正できるようにしておく
- **書き込みAPIには認証が要る。** `CI_LOGIN_BYPASS_SECRET`は本番で無効化される作り
  （[`src/lib/ci-auth-bypass.ts`](../src/lib/ci-auth-bypass.ts)）のため転用できない。専用の
  共有シークレットをorganization secretとして持つ

## 段階

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 読み取りをStatus優先に。`resolveProgressStatus`へ集約 | ✅ 完了（v2.12.0・PR #1003） |
| 2 | 進捗報告APIを作り、issue-deckがProjectを更新する（ラベルと併走） | |
| 3 | 起動をStatus一本化。ボタンもドラッグも「Statusを変える」だけにする | |
| 4 | `shopping-list`・`dayspan`へ展開 | |
| 5 | 進捗ラベルを廃止 | |
| 6 | privateアプリを統合（**この時点でTeamへ上げる**） | |

**Phase 5を後半に置くのは、ラベルが安全網として機能するため。** Statusが壊れてもラベルがあれば
`resolveProgressStatus`がフォールバックする。全リポジトリで安定してから外す。

### Phase 1（完了）

進捗の判定を[`src/lib/issue-progress.ts`](../src/lib/issue-progress.ts)の
`resolveProgressStatus`へ集約し、**Project Statusがあればそれを優先、無ければ進捗ラベルへ
フォールバック**する形にした。これが #991 のスコープ項目5「実行環境に依存しない状態管理
インターフェース」の実体で、GitHub Actionsから更新されようとミニPCから更新されようと、
読む側は同じ入口を通る。

Statusは`projects_v2_item` Webhookと再同期（[`sync-project-status.ts`](../src/lib/github/sync-project-status.ts)）で
`Issue.projectStatus`へ入る。Projects v2はGraphQLのみのため境界は
[`projects-api.ts`](../src/lib/github/projects-api.ts)。

**ナビゲーションビューの絞り込みはラベルベースのまま据え置いている。** 二重運用中は両者が
一致するため実害が無く、`filterIssuesByView`のラベル配列マッチを状態ベースへ変える改修は
影響範囲が広いため。Phase 5で一緒に移す。

### Phase 3 の設計（合意済み）

**起動経路をStatus一本化する。** 「実装を開始」ボタンはStatusとオプションラベルだけを書き、
`@claude`コメントの投稿はWebhookハンドラへ一本化する。ボタンとドラッグが同じ経路を通るため、
二重起動が原理的に起きない。

- 起動対象は**Readyからの遷移のみ**（`Ready → Planning`・`Ready → Implementation`）
- **後戻りには当面なにも割り当てない。** 実行のキャンセルを割り当てるとStatusを書き戻す処理と
  往復しうるうえ、ドラッグの誤操作で実行が止まる影響が大きい
- **オプションラベルを先に、Statusを後に書く。** 逆順だとWebhookが先に届き、「計画が必要」を
  選んだのに実装が始まる
- **Webhookの再配信による二重投稿は、マーカーコメント（`<!-- issue-deck-source:... -->`）の
  有無で防ぐ。** 判定は[`comment-source.ts`](../src/lib/github/comment-source.ts)にある
- **`sender`がissue-deckのGitHub Appなら無視する**
- ボタンがWebhook到達に依存するため、**「起動待ち」の状態表示が必要**

### Phase 6：privateリポジトリ統合時にGitHub Teamへ上げる

privateアプリ（`ops-dashboard`・`vps`・`db-console`・`clip-hive`）を統合する際、GitHub Freeの
制約に2つ同時にぶつかる。

- **organization secretをprivateリポジトリから参照できない**（GitHub Docs
  [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)）。
  上記の共有シークレットが届かない
- **privateリポジトリでブランチ保護が使えない**ため`gh pr merge --auto`が成立せず、最後の
  マージが毎回手動になる

Free前提の分岐（repo secretを配る・auto-mergeを諦める）を設計に持ち込まず、**Teamへ上げることを
前提とする**。費用対効果は[organization-migration.md](organization-migration.md)で「privateを
無人運用へ載せたくなった時点でCへ上げる」と整理済みで、まさにその時点にあたる。

## ローカル実行の主目的はセッションの保持

GitHub Actionsは実行のたびにまっさらなプロセスが立ち、計画・実装・CI修正がそれぞれ独立する。
毎回Issue本文を読み直し、`.shared-context/`をcheckoutし直し、コードを読み直すため、トークンと
待ち時間を消費する。

**self-hosted runnerではこれは解決しない。** ワークフローは毎回新しく起動し
`claude-code-action`も新しいプロセスになる。温まるのはマシン（キャッシュ・worktree）だけで、
会話の文脈は毎回捨てられる。

セッションを保つには**ミニPC上に長時間生きるプロセス**が要る。既存の
[`scripts/run-issue-session.sh`](../scripts/run-issue-session.sh)が「Issue専用worktree＋
開発サーバー＋Claude Codeセッション」を1本のプロセスとして起動しており、部品は揃っている。
現在はフォアグラウンドで1回きりの実行なので、セッションを生かしたまま次の指示を受け取る構造への
作り替えが要る（`claude --resume`）。

振り分けには既存の`11.local`ラベルが使える。付いている間は`claude-issue-dispatch.yml`が
そのIssueに対して何もしない仕組みが既にある（[multi-agent/branching.md](multi-agent/branching.md)）。

方式の詳細設計は規模が別なので専用のIssueで扱う。

## developの一部だけをリリースすることはできない

`develop → main`はブランチ丸ごとのマージで、developにあるものはすべてmainへ行く。
チェリーピックで一部だけ持っていくと、同じ内容でSHAの違うコミットができてmerge-baseがずれ、
以後のリリースで**見かけ上のコンフリクトが多発する**（squash mergeで2回発生した問題と同じ構造。
`.claude/skills/release-to-main/SKILL.md`に記録あり）。

**選択性はブランチではなくフィーチャーフラグで確保する。** Phase 1で導入した
`PROJECT_V2_OWNER`・`PROJECT_V2_NUMBER`（未設定なら連携しない）がその実例で、「マージするか」と
「有効にするか」を分離できている。以降の機能追加も同じ方針を取る。

## 参考リンク

- GitHub Docs: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- GitHub Docs: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)（`projects_v2_item`）
- GitHub Docs: [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)（organization secretのプラン制約）
- 関連ドキュメント: [organization-migration.md](organization-migration.md)（Organization移行の判断材料）・[code-map.md](code-map.md)（データの流れ）
