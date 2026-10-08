# アプリ間共有トークンAPI

**いつ読むか**: issue-deckへ移行した共有トークンを、他アプリまたはAIエージェントから利用するとき。

`issue-deck`が共有トークンの唯一の正です。値を各アプリのDB・設定ファイルへ複製せず、必要な時点で
このAPIから取得します。値の登録と表示はissue-deckの設定画面でも行えます。

## 置いてよいもの・置かないもの（#4048）

共有トークンに置くのは**アプリ間の認証トークンだけ**（アプリAがアプリBのAPIを呼ぶときのBearer鍵、またはその検証側が持つ同じ値）。次の基準で判断する。

| 置く | 置かない |
| --- | --- |
| アプリ間のAPI認証に使う鍵（`OPS_API_TOKEN`・`ISSUE_DECK_IMAGE_UPLOAD_SECRET`・`ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN`など） | 設定値（集計対象のGitHubログイン名など）。環境変数＋`.github/secrets-manifest.tsv`で持つ |
| 複数のアプリが同じ値を読む必要があるもの | 外部サービスのAPIキー（`TYPESAFE_API_KEY`・`OPENAI_API_KEY`など）。アプリ間認証ではないため、従来の環境変数（1Password→GitHub secret→本番`.env`）で持つ |

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

`POST /api/shared-tokens`は`name`を必須とし、任意で`value`・`description`と移行元の
`sourceReference`（`op://`参照など）を受け取ります。**`value`を省略するとissue-deckがランダムな値（URLセーフなbase64・43文字）を生成して**
暗号化保存します（#4121。アプリ間認証用のように値に意味が無いものは省略する）。1Passwordなど外部で値が決まっているものを移すときだけ`value`を渡します。
成功時は`201`でIDと名称を返し、**自動生成したときだけ`generatedValue`を同じ応答に含めます（返すのはこの1回だけ）**。以降は利用側が`GET`で取得します。
同じ名称があるときは`409`です。設定画面でも値を空欄のまま登録すると自動生成し、作成直後に1回だけ表示します。

```json
{
  "name": "EXAMPLE_TOKEN",
  "value": "<トークン値>",
  "description": "example-appの外部API認証用",
  "sourceReference": "op://apps/example-app/external-api-token"
}
```

## 上書き（#3786）

`PUT /api/shared-tokens`は`POST`と同じ本文で（ただし`value`は必須。省略は`400`）、**名前が既にあれば値を置き換え**（`200`）、無ければ作成します（`201`）。
アクセストークンを再発行すると旧値が即座に失効するアプリ（StatusHubの`<アプリID大文字>_ACCESS_APP_TOKEN`など）が、
再発行の直後に新しい値へ差し替えるための経路です。`description`・`sourceReference`は指定したときだけ更新し、
省略すると既存の値を保ちます。利用記録には操作`update`（新規作成時は`create`）と利用元を残し、応答にもログにも値は出しません。
`GET`は60秒キャッシュを持たないので、上書き直後の読み取りから新しい値が返ります。

**書き込める利用元を限定している名前がある（#4164）。** issue-deck自身のログイン判定に使う`ISSUE_DECK_ACCESS_APP_TOKEN`は、
誤った値で上書きされると全員拒否になり、直す設定画面もログインの後ろにあるため画面から戻せない。
そのため`POST`/`PUT`は利用元が`status-hub`（StatusHubの再発行経路）のときだけ受け付け、それ以外は`403 forbidden_name`を返す。
利用元は自己申告のヘッダーなので防げるのは誤操作と無関係な呼び出し元で、`SHARED_TOKEN_API_SECRET`を持つ悪意ある呼び出し元までは防げない
（`SHARED_TOKEN_API_SECRET`は値を読む権限として配る前提で、書き換え権限まで渡す設計ではない点に注意する）。
対応表は`src/lib/shared-tokens.ts`の`PROTECTED_TOKEN_WRITERS`。

各アプリを切り替えたら、issue-deckの設定画面で利用日時と利用元を確認してから、1Password側の旧値を削除します。

## issue-deck自身が使う値は自DBから読む（#3561）

issue-deckは共有トークンの保存先なので、自分が使うアプリ間認証のトークンはAPIを経由せず`src/lib/shared-token-reader.ts`の`resolveSharedToken(共有トークン名, 環境変数名)`でDBから直接復号して読む。60秒メモリへ置き、DBを読んだ時点で利用元`issue-deck`の`SharedTokenUsage`を1件残す（記録の頻度はキャッシュ単位）。**取得できなければ同名の環境変数へ倒す**ので、フォールバックに黙って落ちていないかは設定画面の利用元に`issue-deck`が出ているかで確かめる。

| 共有トークン名 | フォールバックの環境変数 | 読む箇所 |
| --- | --- | --- |
| `OPS_API_TOKEN` | `OPS_API_TOKEN` | `ai-usage-export.ts`・`typesafe/usage-auth.ts`・`dispatch/ops-dashboard-codex-usage.ts` |
| `ISSUE_DECK_IMAGE_UPLOAD_SECRET` | `IMAGE_UPLOAD_SECRET` | `images/image-upload-auth.ts` |
| `ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN` | `AIDE_SUMMARY_SECRET` | `aide-summary-auth.ts`（AIDE向け開発状況サマリAPI。#3999） |
