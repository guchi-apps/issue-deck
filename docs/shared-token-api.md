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

各アプリを切り替えたら、issue-deckの設定画面で利用日時と利用元を確認してから、1Password側の旧値を削除します。
