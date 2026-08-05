# GitHub Appの権限をAdministrationから縮小できるか調査

issue #532 に対応する調査ドキュメント。#523（Issue移動機能`transferIssue`の実装）で出た
「Administrationの権限は強く、リスクがあるのではないか」という懸念を受け、IssueDeckのGitHub Appが
実際にどの機能でどの権限を使っているかを棚卸しし、`Administration`（Read and write）権限をより
狭い権限に置き換えられないかを調査する。**コード変更は行わず、調査結果のドキュメント化のみを行う。**

## 背景（#523での既出情報）

- GraphQLの`transferIssue`ミューテーション（Issue移動機能で使用）はGitHub App固有の
  `Administration`（Read and write）権限でゲーティングされている。OAuth Appのユーザートークンでは
  `repo`スコープの有無によらず常に`Resource not accessible by integration`エラーになる。
- `gh` CLIに`gh issue transfer`相当のコマンドが存在しないのも同じ制約が背景と考えられる（REST APIにも
  Issue移動専用のエンドポイント自体が存在しない）。
- `Administration`権限はGitHub App権限モデル上、Issue移動だけでなく、ブランチ保護ルールの変更・削除、
  コラボレーター管理、Webhook/Deploy Key追加削除、リポジトリの可視性変更・リネーム・削除まで
  一括で許可する広い権限である。

## App全体で実際に使っている権限の棚卸し

IssueDeckのGitHub App認証は`src/lib/github/app-auth.ts`（`@octokit/auth-app`、`GITHUB_APP_ID`・
`GITHUB_APP_PRIVATE_KEY_BASE64`）で行っている。`getInstallationToken()`を使っている全呼び出し箇所と、
そこから呼ばれるGitHub REST/GraphQL APIのエンドポイントを洗い出した結果は以下のとおり。

| 機能 | 呼び出し元 | 主なエンドポイント | 必要な権限（推定） |
|---|---|---|---|
| Issue一覧・コメント・ラベル・担当者の取得/作成/更新/削除 | `src/lib/github/issues-api.ts` | `GET/POST/PATCH /repos/{owner}/{repo}/issues*`、`/labels`、`/assignees` | Issues: Read and write |
| Issue完全削除 | `issues-api.ts`（GraphQLの`deleteIssue`） | `POST /graphql`（`deleteIssue`ミューテーション） | Issues: Read and write（`deleteIssue`はIssues権限で足り、Administrationは不要） |
| **Issue移動** | `issues-api.ts`（GraphQLの`transferIssue`） | `POST /graphql`（`transferIssue`ミューテーション） | **Administration: Read and write（他に選択肢なし）** |
| リポジトリ同期 | `src/lib/github/sync-issues.ts` | `issues-api.ts`経由で上記と同じ | Issues: Read and write |
| リリースPR一覧・ワークフロー実行状況・package.json取得・ワークフローdispatch | `src/lib/github/release-api.ts` | `/actions/workflows/*`、`/contents/package.json`、`/pulls`、`/commits/{ref}/check-runs`、`/actions/workflows/*/dispatches` | Actions: Read and write / Pull requests: Read / Contents: Read / Checks: Read |
| ワークフロー実行の取得・ジョブ取得・キャンセル・強制キャンセル、PR取得、check-runs取得 | `src/lib/github/actions-api.ts` | `/actions/runs/{id}*`、`/pulls/{number}`、`/commits/{ref}/check-runs` | Actions: Read and write / Pull requests: Read / Checks: Read |
| rate_limit取得 | `src/lib/github/rate-limit.ts` | `/rate_limit` | 権限不要（メタデータ相当） |
| インストール情報・リポジトリ一覧取得（セットアップ画面） | `src/app/github/setup/route.ts` | `/app/installations/{id}`、`/installation/repositories` | Metadata: Read（Appインストール時に自動付与） |

**Administrationが必要な箇所は`transferIssue()`の1関数のみ。** それ以外の全機能はIssues/Pull
requests/Actions/Checks/Contents(Read)という、GitHub Appの権限モデル上「通常のIssue/PR管理ボット」
として妥当な範囲に収まっている。

## 「Administrationをより狭い権限に置き換えられるか」の結論

**置き換えられない。** GitHub App権限モデルにはIssue移動専用の権限区分が存在せず、`transferIssue`は
常にAdministration権限にひも付いている（#523で実機検証済み）。したがって「機能を維持したまま
Administrationだけ縮小する」という技術的な解決策は無い。選べる選択肢は実質的に以下の3つで、
いずれもコード変更ではなく製品判断・運用判断になる。

- **選択肢A: Issue移動機能自体を廃止し、Administrationを完全に外す**
  `src/app/api/issues/transfer/route.ts`・Issue移動関連のUI・`use-issue-mutations.ts`のIssue移動
  部分を削除すればAdministrationは不要になり、権限を大きく縮小できる。最もリスクを下げられる
  選択肢だが、機能自体を失うトレードオフがあり、機能要否の製品判断が必要（本Issueの調査範囲外）。
- **選択肢B: 機能もAdministrationも維持し、被害範囲を運用面で抑える**
  既に`22.merge-confirm-required`相当の人間確認フロー（develop向けPRマージ前の確認）が働いている。
  加えて`transferIssue`呼び出し箇所への詳細な監査ログの追加、権限を許可するリポジトリを
  IssueDeck自身の開発リポジトリなど影響が限定される場所に絞る、といった追加策で、権限自体は
  縮小しないまま事故時の影響やトレーサビリティを改善できる。
- **選択肢C: 現状維持（何もしない）**
  GitHub Appの権限は既にGitHub側の設定画面でオーナーの明示的な再承認が必要な操作として独立した
  意思決定ポイントになっており、コードがマージされただけでは権限は変化しない。追加対応をしない
  という判断もあり得る。

いずれを選ぶかはユーザー判断とし、本Issueでは選択肢の整理までに留める。

## 制約・注意点

- 本ドキュメントの棚卸し表は静的コード解析（リポジトリ内のAPI呼び出し箇所の洗い出し）ベースであり、
  各GitHub APIエンドポイントが要求する正確な権限区分（特にActions系のRead/Write境界）はGitHub公式
  ドキュメントの記載に基づく推定を含む。実際のApp設定画面で有効になっている権限一覧そのものは
  今回も確認できていない（#523・[docs/cross-repo-automation.md](cross-repo-automation.md)と同様の
  制約）。
- 本Issueの対応はドキュメント化のみであり、GitHub App自体の権限設定（GitHub側App設定画面）は
  変更しない。選択肢A（Issue移動機能の廃止）を実際に採る場合は、別途ユーザー判断の上で新しい
  Issueとして切り出すのが適切と考える。
