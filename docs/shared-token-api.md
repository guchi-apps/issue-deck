# アプリ間共有トークンAPI

**いつ読むか**: issue-deckへ移行した共有トークンを、他アプリまたはAIエージェントから利用するとき。

`issue-deck`が共有トークンの唯一の正です。値を各アプリのDB・設定ファイルへ複製せず、必要な時点で
このAPIから取得します。値の登録と表示はissue-deckの設定画面でも行えます。

## 認証と利用元

全リクエストに`Authorization: Bearer <SHARED_TOKEN_API_SECRET>`と、利用元を表す
`X-Shared-Token-Consumer: <アプリまたはエージェント名>`を付けます。利用元と取得時刻は記録しますが、
トークン値とBearer値は記録・ログ出力しません。

`SHARED_TOKEN_API_SECRET`が未設定のときは`503`、値が違うときは`401`を返します。

## 取得

`GET /api/shared-tokens?name=<トークン名>`は、見つかったトークンを`{ "name", "value" }`で返し、
利用記録を1件作成します。存在しないときは`404`です。

```bash
curl -fsS "$ISSUE_DECK_URL/api/shared-tokens?name=EXAMPLE_TOKEN" \
  -H "Authorization: Bearer $SHARED_TOKEN_API_SECRET" \
  -H "X-Shared-Token-Consumer: example-app"
```

## 登録

`POST /api/shared-tokens`は`name`と`value`を必須とし、任意で`description`と移行元の
`sourceReference`（`op://`参照など）を受け取ります。値は暗号化して保存し、成功時は`201`でIDと名称だけを返します。
同じ名称があるときは`409`です。

```json
{
  "name": "EXAMPLE_TOKEN",
  "value": "<トークン値>",
  "description": "example-appの外部API認証用",
  "sourceReference": "op://apps/example-app/external-api-token"
}
```

## 上書き（#3786）

`PUT /api/shared-tokens`は`POST`と同じ本文で、**名前が既にあれば値を置き換え**（`200`）、無ければ作成します（`201`）。
アクセストークンを再発行すると旧値が即座に失効するアプリ（StatusHubの`<アプリID大文字>_ACCESS_APP_TOKEN`など）が、
再発行の直後に新しい値へ差し替えるための経路です。`description`・`sourceReference`は指定したときだけ更新し、
省略すると既存の値を保ちます。利用記録には操作`update`（新規作成時は`create`）と利用元を残し、応答にもログにも値は出しません。
`GET`は60秒キャッシュを持たないので、上書き直後の読み取りから新しい値が返ります。

各アプリを切り替えたら、issue-deckの設定画面で利用日時と利用元を確認してから、1Password側の旧値を削除します。

## issue-deck自身が使う値は自DBから読む（#3561）

issue-deckは共有トークンの保存先なので、自分が使う連携トークンはAPIを経由せず`src/lib/shared-token-reader.ts`の`resolveSharedToken(共有トークン名, 環境変数名)`でDBから直接復号して読む。60秒メモリへ置き、DBを読んだ時点で利用元`issue-deck`の`SharedTokenUsage`を1件残す（記録の頻度はキャッシュ単位）。**取得できなければ同名の環境変数へ倒す**ので、フォールバックに黙って落ちていないかは設定画面の利用元に`issue-deck`が出ているかで確かめる。

| 共有トークン名 | フォールバックの環境変数 | 読む箇所 |
| --- | --- | --- |
| `OPS_API_TOKEN` | `OPS_API_TOKEN` | `ai-usage-export.ts`・`typesafe/usage-auth.ts`・`dispatch/ops-dashboard-codex-usage.ts` |
| `ISSUE_DECK_IMAGE_UPLOAD_SECRET` | `IMAGE_UPLOAD_SECRET` | `images/image-upload-auth.ts` |
| `TYPESAFE_API_KEY` | `TYPESAFE_API_KEY` | `typesafe/system-one.ts` |
| `ISSUE_DECK_AIDE_SUMMARY_SECRET` | `AIDE_SUMMARY_SECRET` | `aide-summary-auth.ts`（AIDE向け開発状況サマリAPI。#3999） |
| `ISSUE_DECK_AIDE_SUMMARY_USER` | `AIDE_SUMMARY_USER_LOGIN` | 同上（集計の対象利用者のGitHubログイン名。秘密ではないが同じ置き場に置く） |
