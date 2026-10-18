# 作業Issueフロー（#4520）の全リポジトリ展開 — 対象調査と進捗（#4525）

#4525 の記録。**このドキュメントの調査結果は取得時点（2026-10-18）のスナップショット**で、
配布状況の正はcallerファイル（[supported-repositories.md](supported-repositories.md)の注記と同じ）。
配り方の一般論は [multi-repo-changes.md](multi-repo-changes.md)。

## 現在の到達点（タグを配れる状態ではない）

| 前提 | 状態（2026-10-18） | 影響 |
|---|---|---|
| #4521・#4522・#4523・#4524 | PRはいずれも`develop`へマージ済み。**`main`へは未反映**（Issueはopen） | 共有タグ`workflows/vN`は`main`の先端から切るため、`develop`→`main`のリリースを通すまで新仕様のタグは作れない |
| guchi-apps/docs#226 | PR `guchi-apps/docs#236`が未マージ（`00.check-user`＋`01.check-merge`） | 全アプリ共通ルールがまだ旧文面。Actions・ローカルでの参照確認ができない |
| 最新タグ | `workflows/v53`（上の変更を含まない旧仕様） | **旧仕様のタグを配って本Issueの完了にしない**（Issue本文） |

したがって展開（タグ公開・参照更新PR・実走）は上の2点が済むまで保留し、依存待ちとして登録した。
本PRは先行できる「対象の確定と調査」だけを記録する。**本PRのマージは展開完了を意味しない**（途中PR）。

## 対象の全体像（guchi-apps の非アーカイブ 27 リポジトリ）

取得は `gh repo list guchi-apps --no-archived`（privateは権限内で確認。取得不能は無かった）。
直近のpush日では絞っていない（最終pushが2026-06〜07のものも含めて分類した）。

### A. 導入済み（`claude-review-develop.yml`等のcallerを持つ）— 19

`issue-deck`（ローカルパス参照）・`meisai-lab`・`yoteiflow`・`car-care`・`solitaire`・`pi0w`・
`asset-manager`・`status-hub`・`stockly`・`kurashio`・`work-relay`・`db-console`・`morrow`・
`clip-hive`・`signaly`・`aide`（以上public）。`aide-ios`は今回の一覧（非アーカイブのguchi-apps）に現れなかったため、
別org／別名の有無を[supported-repositories.md](supported-repositories.md)で要確認。

| 観点 | 結果 |
|---|---|
| `claude-review-develop.yml`・`release-develop-to-main.yml`のuses | 全て`workflows/v53`（`db-console`・`morrow`のrelease callerに`v52`と`v53`が混在、要確認） |
| `claude-issue-dispatch.yml`のuses／`prompts-ref` | **全て`v52`**。IssueのActions実装は#4680で廃止済みのため、このcallerはタグ配布の対象にせず、旧タグで動く配布先向けの互換扱い |
| 異常 | `signaly`の`claude-issue-dispatch.yml`に`workflows/v10`の参照が残っている（`prompts-ref`は`v52`） |
| `CLAUDE.md`の固有ルール | `meisai-lab`・`car-care`・`status-hub`・`db-console`は11バイト（実質空）。`yoteiflow`（約353KB）・`morrow`（約273KB）・`kurashio`（約105KB）は大きく、旧「手作業は起案時に固定」の記述が残っていないかの個別確認が要る（後述） |

### B. 無人実行を持たない運用リポジトリ — 6

`docs`・`vps`・`subpc`（private・main運用）、`question`・`ideas`・`claude-config`（private）。
いずれも無人実装を入れない判断（[supported-repositories.md](supported-repositories.md)）。
共通フローの対象は「共有知識（`docs`）とローカルセッションが読むルール」で、`docs`は#226が窓口。

### C. 共通自動化を使わない（`.github/workflows`なし）— 5

| リポジトリ | 理由・扱い |
|---|---|
| `gucchii-os`・`uptime-kuma`・`wifi-speed` | ワークフロー・`CLAUDE.md`とも無し。説明も無く用途不明。**導入するか対象外かの判断が要る**（セットアップIssue or 対象外の記録のどちらかをユーザーが決める） |
| `sensor_260531`（リビング設置中）・`sensor_260218`（設置なし）| ラズパイセンサー。private・`master`/`main`運用。実機運用でコードの共通フロー対象外が自然だが、**未確認のため暫定**扱い |

## 残る作業（依存待ちの後に実施）

1. `develop`→`main`のリリース（人が実施）後、`workflows/vN`を切る → 画面「新しいタグを切って配る」で全導入先へ配布PR
2. `guchi-apps/docs#236`のマージ後、Actions（`.shared-context/`）・ローカル（`~/apps/_docs`）の双方で新ルールが読まれることの確認
3. 大きい固有`CLAUDE.md`（`yoteiflow`・`morrow`・`kurashio`・`stockly`・`asset-manager`・`signaly`）の旧ルール矛盾確認 → 矛盾がある対象にだけ個別Issue（重複を探してから起票）
4. `signaly`の`v10`参照、`db-console`・`morrow`のrelease callerの`v52`/`v53`混在の修正（配布PRで解消しなければ個別Issue）
5. 新規アプリ雛形（`src/lib/new-app/scaffold.ts`）が新方式のまま届くことの確認
6. 代表実走（Web・iOS含む・実機デプロイ・private運用）と、設定整合確認との区別した記録
7. 新旧混在期間の互換確認（旧`71.manual-step`本文・ラベル・進行中セッション。未対応ホストへ新ジョブを送らない）
8. 親Epic #4520 の残作業へ、上記の未了・取得不能・実走不能を反映

## 再調査の手順

```bash
for r in $(gh repo list guchi-apps --limit 200 --no-archived --json name -q '.[].name'); do
  b=$(gh api repos/guchi-apps/$r --jq .default_branch)
  gh api "repos/guchi-apps/$r/contents/.github/workflows/claude-review-develop.yml?ref=$b" --jq .content 2>/dev/null \
    | base64 -d | grep -oE 'workflows/v[0-9]+' | sort -u | sed "s/^/$r /"
done
```
