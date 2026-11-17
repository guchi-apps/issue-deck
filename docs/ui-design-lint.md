# UIデザインの静的検出（#5465）

AIっぽい既定の見た目を機械的に拾い、PRで**警告として**指摘する。基準の正は共有知識の
`standards/ui-design.md`（guchi-apps/docs#281）。親: #5464。

## 土台の結論: 自作（Impeccableは採用しない）

- Impeccable（pbakaus/impeccable、Apache-2.0、62ルール）はネイティブバイナリを実行時に取得する起動ラッパーで、
  採用すると依存の追加と実行時ダウンロードが増える
- 62ルールは我々の基準（禁止7項目）と一致せず、誤判定の調整を外部に任せることになる
- 自作は`scripts/check-ui-design.mjs`1本（依存ゼロ）で、基準の表と1対1にできる

比較のためにImpeccableを試したくなったら、依存追加なので事前にユーザーへ確認する（`npx impeccable detect src/`を1回走らせるだけなら追加にはならない）。

## ルール

| ルール | 見るもの |
|---|---|
| `side-border` | `border-l-2〜8`・`border-r-2〜8`と色クラスが同じ行にある |
| `gradient` | `bg-gradient-*`・`bg-linear-*`・`linear-gradient(`など。`repeating-*-gradient`（グラフの塗り分けパターン）は見ない |
| `emoji-icon` | 絵文字（🚀・✅・❌など）。✓・×・★のようなテキスト記号とコメント行は見ない |
| `heavy-shadow` | `shadow-lg/xl/2xl`。メニュー・ダイアログ・トーストは除外して仕分ける |

「全セクションをカードで囲む」「色付きバッジの乱用」は行単位の検出では誤判定が多いため、**今回の対象外**
（自動レビューのデザイン観点で扱う。#5464の別の子Issue）。

## 意味のある使い方の除外

検出した行か直前の行に`design-ok: <理由>`を書く。**理由が空だと除外にならない**。

```tsx
{/* design-ok: 引用ブロックの左線（引用という意味を伝える） */}
<blockquote className="border-l-2 border-muted-foreground pl-3">
```

## 使い方

```bash
node scripts/check-ui-design.mjs src            # 表
node scripts/check-ui-design.mjs --report src   # Markdown（docs/ui-design-audit.md の元）
node scripts/check-ui-design.mjs --github src   # ::warning 注釈（CI）
node scripts/check-ui-design.mjs --json src
```

終了コードは常に0。`--strict`を付けたときだけ検出があれば1（今は使わない）。

## 警告のみで運用する

CIの`ui-design-notice`ジョブがPRに注釈を出す。ステップ単位の`continue-on-error`で、`ci/required-checks.json`にも
載せない（`INFORMATIONAL_JOBS`で管理）ため、マージも合否も止めない。誤判定が少ないと確認できてから、
止めるかどうかを別途決める。

## 他リポジトリへの展開方針（本Issueでは方針のみ）

1. スクリプトは依存ゼロの単一ファイルなので、`propagate-shared-files.yml`で配る共有ファイルに加える
2. 注釈ジョブは共有ワークフロー`reusable-ui-design-check.yml`へ切り出し、各リポジトリのcallerが`@workflows/vN`で参照する
3. 対象ディレクトリ（`src`・`app`など）はcallerの`with:`で渡す。既定は`src`
4. 配布は#2790と同じく、リリース→参照タグの配布を経て効く。配る作業は別Issueで起票する

## 全体の走査結果

[ui-design-audit.md](ui-design-audit.md)。仕分け（装飾か、意味ありか）は是正Issueで人が埋める。

## 自動レビューのデザイン観点（#5466）

静的検出が拾えない判断（意味のある装飾か、情報の階層が適切か）は、自動レビュー
（`.github/prompts/review-develop.md`の「デザイン観点」）が担当する。

- UIファイルの変更があるPRだけで行い、無いPRでは何も書かない
- 静的検出の結果（`--json`）を先に読み、`design-ok`の理由を踏まえて装飾かどうかを判断する
- 指摘は`### デザイン上の警告`にまとめる警告のみで、総評・判定マーカー・自動マージ・自動修正には影響しない
- 静的検出スクリプトは**PR側のチェックアウトからは実行しない**。`reusable-claude-review-develop.yml`が
  `prompts-ref`指定時はその版、無指定（issue-deck自身）はPRのbaseの版を`$RUNNER_TEMP`へ複製し、
  パスを`UI_LINT_SCRIPT`でプロンプトへ渡す。取得できないときは静的検出を使わず観点だけで見る
