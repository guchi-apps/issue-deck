# 全体レビュー・修正の外部エージェント向けAPI／MCP

**いつ読むか**: 外部のエージェント（Claude Codeなど）から、リリース候補の全体レビュー・統合検証・修正の状態を取得し、担当の取得・修正・独立レビュー・テストの報告で続きを実行させるとき。#4588。

## 全体像

- REST（`/api/review-agent/tools[/<name>]`）とMCP（`/api/mcp/review-agent`）は、**同じツール定義（`src/lib/review-agent/service.ts`の`callReviewAgentTool`）だけ**を呼ぶ。認可・状態遷移・応答が食い違わない
- 新しい結果の保存先は持たない。読むのは既存の台帳（`ReleaseVerification`・`ReleaseCandidate`/`Revision`/`Finalization`・`ReleaseFixSeries`・内部確認の`ReleaseFixInternalSession/Round/Finding`）。更新は`release-fix-internal-run.ts`（#4410・#4587）の担当取得・報告・一時停止・再開へ委譲する
- ブラウザのログインは使わない。実行ホスト用の共有シークレット（`PROGRESS_REPORT_SECRET`など）も外へ配らない。**専用トークン**（`ida_…`）で認証する
- 任意SQL・テーブルCRUD・DB資格情報は公開しない。ツールは下表の9つだけ

## 認証

`Authorization: Bearer ida_…`。トークンは設定＞フリート運用の「外部エージェント用トークン」で発行する（`POST /api/settings/review-agent-tokens`。ログイン済みの利用者本人だけ）。

| 項目 | 内容 |
| --- | --- |
| 値の保存 | SHA-256のハッシュだけ。発行時の1回しか表示しない |
| 利用者 | 発行した利用者に結び付く。**許可するrepositoryは発行者が連携しているものだけ**で、使うたびに連携が残っているかを再確認する（外れていれば`404 repository_not_found`） |
| repository | 許可リスト（1〜50件）。全許可は無い。リスト外は`403 repository_not_allowed`。画面ではissue-deckが管理するrepositoryから選択し、発行後も「許可repositoryを編集」（`PATCH /api/settings/review-agent-tokens`）で値を変えずに追加・削除できる（失効・期限切れは不可。新たに加えるものだけ連携を確認し、残すものは照合しない）。変更は`ReviewAgentAuditLog`へ1repositoryにつき1行（`token_repo_add`／`token_repo_remove`）残る |
| 操作範囲 | `read`（取得）・`write`（担当の取得/解放・一時停止・テストと独立レビューの報告）・`resume`（一時停止の再開）。足りなければ`403 scope_not_allowed` |
| 期限・失効 | 1〜365日。失効・期限切れは`401`（`token_revoked`・`token_expired`）＋`WWW-Authenticate` |
| 本番マージ・公開 | **どの範囲にも含まない**。この経路の再開・報告で本番マージ・公開の承認を代替しない |

## ツール

| ツール | 範囲 | 内容 |
| --- | --- | --- |
| `list_release_candidates` | read | 候補一覧（新しい順）。`limit`・`cursor`（前の`page.nextCursor`）でページング |
| `get_release_candidate` | read | 候補1件のrevision履歴・現行の全体レビュー（指摘全文・重要度・根拠・推奨対応・確認項目・未確認範囲）・統合検証・検証履歴・継承の根拠・関連修正Issue/PR・担当/停止理由/次の操作 |
| `get_fix_status` | read | 修正Issue1件の指摘（`F-001`…）・往復・テスト・担当と世代`epoch`・一時停止の理由と次の操作 |
| `claim_fix` | write | 担当の取得。別の担当が持ち時間内なら`takeover: true`で引き継ぐ。応答の`epoch`を以降の報告へ添える |
| `release_fix` | write | 担当の解放（記録は保持） |
| `pause_fix` | write | `environment`（実行環境の障害）か`needs_decision`（人の判断・権限の不足）で一時停止 |
| `resume_fix` | resume | 回復済みの`environment`停止だけを再開。予算の追加・方針が要る停止は画面から人が再開する |
| `report_fix_test` | write | テスト結果。**実際に検証した`sha`（40桁）が必須** |
| `report_fix_review` | write | 独立レビュー結果（`pass`/`findings`・新しい指摘・解消した指摘とその根拠`resolution`）。**`sha`必須、実装担当と同じトークンは独立レビューにならない** |

更新には操作ごとに新しい`idempotencyKey`（8〜120文字）と`agent`（このエージェントの識別名）が要る。

### 取得の読み方

- 現行の結果と旧SHAの結果を区別する。履歴の各行の`relation`は`current`（現行revisionの対象）／`stale_sha`（旧SHA。現在の合否に使わない）／`inherited`（公開準備でバンプ前の合格を引き継いだ派生記録。`inheritedFromHeadSha`が元で、`message`に理由。根拠は`inheritance`）
- 現行revisionが適用済みでない候補は`verification: null`と`verificationNotice`を返す（履歴のみ）
- **黙って省略しない**: 指摘・提案は`findingsOffset`/`findingsLimit`でページングし、`total`・`truncated`・`nextOffset`を返す。revision・履歴・修正系列にも件数と`truncated`がある。修正系列の内部確認の詳細は新しい10件だけで、他は`internalIncluded: false`で示す
- 指摘IDは#4559の安定ID（`R-xxxxxx`）。修正Issue側の指摘は内部確認のキー（`F-001`）
- **取得はGitHubを呼ばず、何も書かない**（監査にも記録しない）。更新時にだけブランチのHEADをサーバーが取り直す

### 更新の検証（報告が実際に検証したものへ結び付く）

- `sha`が、サーバーが取り直した`issue-<番号>`ブランチのHEADと違えば`409 stale_sha`（現在のHEADを`details.currentSha`で返す）。**旧い検証を最新HEADへ付け替えない**。旧実行ホストの経路（`/api/dispatch/release-fix-internal`）は`sha`を送らないので従来どおり
- 担当が変わった後・解放された後の遅延報告は`409 stale_assignee`。独立レビューも担当の`epoch`が合わなければ弾く
- 独立レビューは、同じトークンが担当を取った記録がある場合に`409 self_review_not_independent`。レビュー主体は往復の`reviewerKind`/`reviewerRef`に残る
- 同じ`idempotencyKey`・同じ内容の再送は、保存した結果を`replayed: true`で返し二重に実行しない。同じキーで内容が違えば`409 idempotency_conflict`、実行中なら`409 in_progress`。**成功した結果だけを保存**し、拒否された操作は取得し直して再送できる
- 拒否の応答は`error`・`message`・`refetchRequired`（取得し直し・再検証が必要か）を持つ。停止中（`paused`）・置換済み/未登録（`series_not_found`・`not_resumable`）・旧版（`stale_*`）を区別する

### 監査

更新と拒否（権限拒否を含む）を`ReviewAgentAuditLog`へ記録する（トークン・利用者・ツール・repository・Issue・結果・時刻）。レビュー本文・値は入れない。

## 接続（Claude Code）

```bash
claude mcp add --transport http issue-deck-review https://<issue-deckのホスト>/api/mcp/review-agent \
  --header "Authorization: Bearer ida_…"
```

- Streamable HTTPのうちPOSTだけに対応（`GET`は405。SSEなし）。`initialize`・`tools/list`・`tools/call`・`ping`を実装する。依存パッケージは追加していない
- トークンが無効なときはJSON-RPCではなくHTTP 401＋`WWW-Authenticate: Bearer`を返す
- REST: `GET /api/review-agent/tools`で一覧、`POST /api/review-agent/tools/<name>`にJSONの引数を渡す（読み取りのツールも同じ形。副作用なし）

## 既存のAIDE MCPとの関係（調査結果）

AIDEのMCPは別リポジトリ側の公開基盤で、issue-deckの個別API（画像アップロード・開発状況サマリ）を専用の共有鍵で呼ぶ。今回のツールをAIDE経由で出すには、AIDE側にツールの追加と専用トークンの保管が要る。**issue-deck内蔵のMCPを主経路にし、AIDEへの統合は別リポジトリの作業として追跡する**（#4588から起票）。
