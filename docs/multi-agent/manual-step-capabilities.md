# 作業セッションの実行能力の実測と本人操作の依頼（#4522）

いつ読むか: 手作業セッション・汎用実装セッションが「どの手段で、どのホストで進めるか」を判断する仕組みを触るとき。

## 方針

- 「ブラウザだから本人」と一律に止めない。API・CLI・SSH・ブラウザ操作から対象に合う手段を選ぶ
- 能力は**実測**で決める。`scripts/lib/session-capabilities.sh`が`gh`・VPSへのSSH・ヘッドレスChromiumの起動・操作ドライバ（playwright）・認証済みプロファイルの有無を試し、`ok`／`missing`／`unverified`で出す。起動時に`start-manual-step-session.sh`がプロンプトの`{{HOST_CAPABILITIES}}`へ埋め込む
- 認証済みプロファイルは`ISSUE_DECK_BROWSER_PROFILE_DIR`（既定`~/.config/issue-deck/browser-profile`）。あっても有効かは確かめないので`unverified`止まり。ログインが要る操作は本人に最小の依頼を出す
- 人に頼むのは本人認証・物理操作・不足権限・未承認の重要判断だけ。状態は「本人操作待ち／未対応ツール／権限不足／実行失敗／依存待ち／外部反映待ち」を混同しない
- 完了は終了コードだけで決めない。完了検証コメントに`- 条件: … / 結果: 達成|未達 / 確認: … / 根拠: …`を並べ、1つでも未達なら画面は完了にしない（`parseManualStepVerification`）

## 規約の置き場

判断規約は`scripts/prompts/manual-step-agent.md`と`generic-implementation-agent.md`に同じ文面で置く（`scripts/manual-step-prompt.test.mjs`が揃いを検証）。後者は`templates.generated.ts`へ埋め込まれるので、変えたら`node scripts/generate-prompt-templates.mjs`を実行する。

## 未対応

認証済みブラウザプロファイルの用意（ホストのセットアップ）は`guchi-apps/subpc`側の作業。無人実行（GitHub Actions）にはブラウザ能力がないため効かない。
