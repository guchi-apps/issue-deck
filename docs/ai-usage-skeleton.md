# AI使用量の読み込み表示

`src/components/dashboard/session-usage-panel.tsx` の期間集計は、初回取得と集計期間の切替で `PeriodSkeleton` を表示する。

- 集計カードは従量課金相当、応答、入力トークン、セッション、実行したIssueの順に5枚並ぶ。
- 読み込み中と実表示は `SUMMARY_GRID_CLASS_NAME` を共用し、スマホで2列、sm以上で5列にする。
- カード下の案内文は `SUMMARY_BASIS_HINT` を共用する。
- カードの追加・削除や順序を変えるときは、実表示と `PeriodSkeleton` の両方を更新する。入力トークンの帯にも場所を確保する。

Related: #4371
