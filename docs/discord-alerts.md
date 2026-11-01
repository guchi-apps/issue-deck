# GitHub Actionsの異常通知（Discord）

Signalyの通知を廃止した（#5057・#5180）後に残る異常通知の経路。**失敗・明確な異常だけ**をDiscordへ送り、成功・通常リリース・通常収集・キャンセルは送らない。

## 仕組み

- 配布元は `.github/scripts/discord-alert.sh`。環境変数 `DISCORD_ALERT_WEBHOOK_URL`（webhook）と `NOTIFY_STATUS` を受け取る。
- `NOTIFY_STATUS` が `failure`（ジョブ失敗）か `anomaly`（ワークフローは成功でも異常を表す。ドリフト検知など。説明は `NOTIFY_DETAIL`）のときだけ送る。それ以外は何もしない。
- **ジョブ結果は改変しない。** 呼び出し側は元の結果をそのまま渡し、スクリプトは常に終了コード0で返す。呼び出しステップには `continue-on-error: true` を付ける。
- **webhook URLは秘密。** Actionsログは公開されるため、curlのstderrは捨て、HTTPコードとcurl終了コードだけを出す。`allowed_mentions` は空にしてメンションを起こさない。
- リリース完了の通知はIssueDeck→Discordの別経路が持つ。ここではリリースの**失敗だけ**を送り、成功は送らない（重複させない）。

## 現在の段階（併走）

issue-deck自身の `ci.yml`・`deploy.yml`・`release.yml`・`ios-testflight.yml` と、新規アプリの生成物（`scaffold-workflows.ts`）にDiscordのステップがある。併走していたSignalyの通知ステップ・`signaly-notify.sh`・`SIGNALY_*` のsecret参照は撤去した（#5180。代替の通知先は用意しない）。

`DISCORD_ALERT_WEBHOOK_URL` が未登録の間は警告を出して0で返す。マニフェストへの行追加は、1Passwordへの登録と同期が済んでから行う。

## 残作業

- webhookの発行・登録（外部サービスの値）と、実到達の確認
- 他リポジトリへの展開（リポジトリごとにIssue。`propagate-shared-files`は既存ファイルにしか配らないため、初回の導入は別途）
